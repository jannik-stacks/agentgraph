import { z } from 'zod';
import type { Verdict } from './store.ts';

const instructions = z.union([z.string().min(1), z.record(z.string(), z.unknown()), z.array(z.unknown()).min(1)]);

/** One question for the decision model: a yes-or-no probability, a pick among named options, or a graded score. */
export const Question = z.discriminatedUnion('type', [
  z.strictObject({ type: z.literal('noul'), instructions }),
  z.strictObject({
    type: z.literal('choice'),
    instructions,
    criteria: z
      .record(z.string(), z.string().nullable())
      .refine(c => Object.keys(c).length >= 2 && Object.keys(c).length <= 26, 'needs 2 to 26 options'),
  }),
  z.strictObject({ type: z.literal('score'), instructions, criteria: z.array(z.string().min(1)).min(2).max(26) }),
]);
export type Question = z.infer<typeof Question>;

const probabilities = z.record(z.string(), z.number());

/** `noul` is the probability of yes; `score` is the expected index into the criteria. */
export const Answer = z.discriminatedUnion('type', [
  z.object({ type: z.literal('noul'), noul: z.number() }),
  z.object({ type: z.literal('choice'), choice: z.string(), probabilities, confidence: z.number() }),
  z.object({
    type: z.literal('score'),
    score: z.number(),
    legend: z.record(z.string(), z.string()),
    probabilities,
    confidence: z.number(),
  }),
]);
export type Answer = z.infer<typeof Answer>;

export const DecideRequest = z.strictObject({
  model: z.string().min(1),
  state: z.union([z.string(), z.record(z.string(), z.unknown()), z.array(z.unknown())]),
  questions: z
    .record(z.string().min(1), Question)
    .refine(q => Object.keys(q).length >= 1 && Object.keys(q).length <= 64, 'needs 1 to 64 questions'),
});
export type DecideRequest = z.infer<typeof DecideRequest>;

const DecideResponse = z.object({
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
});

export const defaultDecideUrl = 'http://127.0.0.1:11434';
export const defaultDecideModel = 'tev1:0.8b';
export const defaultThreshold = 0.5;

type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Extract<Answer, { type: Q[K]['type'] }> };

/**
 * Asks Ollama's decision API (`/v1/systemone`) about `state`. `url` is the Ollama base URL.
 *
 * @throws when the request is invalid, the call times out, the server answers with an error, or an answer is missing.
 * @example
 * const { ok } = await decide({ url, model: 'tev1:0.8b', state: 'Message: fix typo', questions: { ok: { type: 'noul', instructions: 'Is the message exactly "update"?' } } });
 * ok.noul; // probability of yes
 */
export const decide = async <Q extends Record<string, Question>>({
  url = defaultDecideUrl,
  timeoutMs = 60_000,
  ...request
}: Omit<DecideRequest, 'questions'> & { questions: Q; url?: string; timeoutMs?: number }): Promise<Answers<Q>> => {
  const body = DecideRequest.safeParse(request);
  if (!body.success) throw new Error(`decide: invalid request: ${z.prettifyError(body.error)}`);
  const endpoint = `${url.replace(/\/+$/, '')}/v1/systemone`;
  let response: Response;
  try {
    response = await fetch(endpoint, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body.data),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    const reason =
      e instanceof Error && e.name === 'TimeoutError'
        ? `timed out after ${timeoutMs} ms`
        : e instanceof Error
          ? e.message
          : String(e);
    throw new Error(`decide: ${endpoint}: ${reason}`);
  }
  const text = await response.text();
  const json = (() => {
    try {
      return JSON.parse(text) as unknown;
    } catch {
      return undefined;
    }
  })();
  if (!response.ok) {
    const message = (json as { error?: unknown } | undefined)?.error;
    throw new Error(`decide: ${response.status}: ${typeof message === 'string' ? message : text.slice(0, 200)}`);
  }
  const parsed = DecideResponse.safeParse(json);
  if (!parsed.success) throw new Error(`decide: unexpected response: ${z.prettifyError(parsed.error)}`);
  for (const [key, question] of Object.entries(request.questions)) {
    const answer = parsed.data.answers[key];
    if (answer?.type !== question.type) throw new Error(`decide: no ${question.type} answer for "${key}"`);
  }
  return parsed.data.answers as Answers<Q>;
};

const maxState = 16_000;

const clipped = (text: string) => (text.length > maxState ? `${text.slice(0, maxState)}\n[truncated]` : text);

/**
 * Asks the decision model one yes-or-no `question` about `state` and passes when the probability of yes is at or
 * above `threshold`. Fails closed when the model cannot be reached. Reads `BOTHUB_DECIDE_URL` and
 * `BOTHUB_DECIDE_MODEL` from `env`.
 */
export const decideCheck = async (
  question: string,
  state: string,
  env: Record<string, string | undefined>,
  threshold = defaultThreshold
): Promise<Pick<Verdict, 'pass' | 'findings'>> => {
  try {
    const { answer } = await decide({
      url: env.BOTHUB_DECIDE_URL || defaultDecideUrl,
      model: env.BOTHUB_DECIDE_MODEL || defaultDecideModel,
      state: clipped(state),
      questions: { answer: { type: 'noul', instructions: question } },
    });
    return {
      pass: answer.noul >= threshold,
      findings: `${question} Probability of yes ${answer.noul.toFixed(3)}, threshold ${threshold}.`,
    };
  } catch (e) {
    return { pass: false, findings: e instanceof Error ? e.message : String(e) };
  }
};
