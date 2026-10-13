import { z } from 'zod';
import type { Verdict } from './store.ts';
import { complete, endpointOf, type Endpoint } from './summaries.ts';
import { meter, type Usage } from './usage.ts';

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

/** About 1,300 tokens of state, which leaves room for the questions in tev1:0.8b's 2,048-token context. */
const maxState = 4_000;

const fitted = (text: string) =>
  text.length > maxState ? `${text.slice(0, maxState / 2)}\n[…]\n${text.slice(-maxState / 2)}` : text;

const DecideResponse = z.object({
  answers: z.record(z.string(), Answer),
  usage: z.object({ input_tokens: z.number(), output_tokens: z.number() }).optional(),
  prompt_eval_cached_count: z.number().optional(),
});

export const defaultDecideUrl = 'http://127.0.0.1:11434';
export const defaultDecideModel = 'tev1:0.8b';

type Answers<Q extends Record<string, Question>> = { [K in keyof Q]: Extract<Answer, { type: Q[K]['type'] }> };

/** Whether `model` is a chat model behind the LLM proxy, such as `luna`, rather than an Ollama model with a `:tag`. */
export const viaChat = (model: string) => !model.includes(':');

const chatSystem =
  'You answer yes-or-no questions about the state the user gives. Reply with only a JSON object that maps each question id to the probability, from 0 to 1, that the answer is yes.';

const probability = (value: unknown) => {
  if (typeof value === 'boolean') return value ? 1 : 0;
  if (value === 'yes') return 1;
  if (value === 'no') return 0;
  const n = typeof value === 'string' && value.trim() ? Number(value) : value;
  if (typeof n !== 'number' || !Number.isFinite(n)) return undefined;
  return Math.min(1, Math.max(0, n));
};

/** The probability of yes for each question id in a chat model's reply; unreadable answers are left out. */
export const chatAnswers = (reply: string): Record<string, number> => {
  const json = /\{[\s\S]*\}/.exec(reply)?.[0];
  if (!json) return {};
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return {};
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return {};
  return Object.fromEntries(
    Object.entries(parsed).flatMap(([id, value]) => {
      const p = probability(value);
      return p === undefined ? [] : [[id, p]];
    })
  );
};

const text = (value: unknown) => (typeof value === 'string' ? value : JSON.stringify(value, null, 2));

const askChat = async (
  llm: Endpoint | undefined,
  timeoutMs: number,
  { model, state, questions }: DecideRequest,
  onUsage?: (usage: Usage) => void
): Promise<Record<string, Answer>> => {
  if (!llm) throw new Error(`decide: ${model} is a chat model and BOTHUB_LLM_BASE_URL is not set`);
  const other = Object.entries(questions).find(([, q]) => q.type !== 'noul');
  if (other) throw new Error(`decide: ${model} answers only noul questions, "${other[0]}" is ${other[1].type}`);
  const asked = Object.entries(questions).map(([id, q]) => `${id}: ${text(q.instructions)}`);
  const user = `<state>\n${text(state)}\n</state>\n\nQuestions:\n${asked.join('\n')}`;
  const reply = await complete({ ...llm, timeoutMs }, model, chatSystem, user, 256 + 16 * asked.length, onUsage);
  return Object.fromEntries(
    Object.entries(chatAnswers(reply)).map(([id, noul]) => [id, { type: 'noul' as const, noul }])
  );
};

const askDecisionApi = (url: string, timeoutMs: number, request: DecideRequest, onUsage?: (usage: Usage) => void) =>
  meter(request.model, onUsage && (usage => onUsage({ ...usage, direct: true })), async () => {
    const endpoint = `${url.replace(/\/+$/, '')}/v1/systemone`;
    let response: Response;
    try {
      response = await fetch(endpoint, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
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
    const body = await response.text();
    const json = (() => {
      try {
        return JSON.parse(body) as unknown;
      } catch {
        return undefined;
      }
    })();
    if (!response.ok) {
      const message = (json as { error?: unknown } | undefined)?.error;
      throw new Error(`decide: ${response.status}: ${typeof message === 'string' ? message : body.slice(0, 200)}`);
    }
    const parsed = DecideResponse.safeParse(json);
    if (!parsed.success) throw new Error(`decide: unexpected response: ${z.prettifyError(parsed.error)}`);
    const { answers, usage, prompt_eval_cached_count: cached } = parsed.data;
    return {
      value: answers,
      tokens: {
        inputTokens: usage?.input_tokens ?? 0,
        outputTokens: usage?.output_tokens ?? 0,
        ...(cached && { cachedInputTokens: cached }),
      },
    };
  });

/**
 * Asks the decision model about `state`: Ollama's decision API (`/v1/systemone`) at the base URL `url`, or, for a
 * model without a `:tag` (see `viaChat`), the chat model at `llm`, which answers only `noul` questions. A text state
 * longer than 4,000 characters keeps its head and tail. The model call, failed or not, goes to `onUsage`. A chat
 * model's unreadable answers are left out.
 *
 * @throws when the request is invalid, the call times out or the server answers with an error.
 */
export const ask = async ({
  url = defaultDecideUrl,
  llm,
  timeoutMs = 60_000,
  onUsage,
  ...request
}: DecideRequest & {
  url?: string;
  llm?: Endpoint | undefined;
  timeoutMs?: number;
  onUsage?: ((usage: Usage) => void) | undefined;
}): Promise<Partial<Record<string, Answer>>> => {
  const body = DecideRequest.safeParse({
    ...request,
    state: typeof request.state === 'string' ? fitted(request.state) : request.state,
  });
  if (!body.success) throw new Error(`decide: invalid request: ${z.prettifyError(body.error)}`);
  return viaChat(body.data.model)
    ? askChat(llm, timeoutMs, body.data, onUsage)
    : askDecisionApi(url, timeoutMs, body.data, onUsage);
};

/**
 * `ask`, with every question answered.
 *
 * @throws as `ask` does, and when an answer is missing.
 * @example
 * const { ok } = await decide({ url, model: 'tev1:0.8b', state: 'Message: fix typo', questions: { ok: { type: 'noul', instructions: 'Is the message exactly "update"?' } } });
 * ok.noul; // probability of yes
 */
export const decide = async <Q extends Record<string, Question>>(
  request: Parameters<typeof ask>[0] & { questions: Q }
): Promise<Answers<Q>> => {
  const answers = await ask(request);
  for (const [key, question] of Object.entries(request.questions)) {
    if (answers[key]?.type !== question.type) throw new Error(`decide: no ${question.type} answer for "${key}"`);
  }
  return answers as Answers<Q>;
};

/**
 * Asks the decision model one yes-or-no `question` about `state` and passes when the probability of yes is at or
 * above `threshold`, or always without one, which only records the probability. Fails closed when the model cannot be
 * reached. Reads `BOTHUB_DECIDE_URL`, `BOTHUB_DECIDE_MODEL` and, for a chat model, `BOTHUB_LLM_BASE_URL` and
 * `BOTHUB_LLM_API_KEY` from `env`. The model call goes to `onUsage`.
 */
export const decideCheck = async (
  question: string,
  state: string,
  env: Record<string, string | undefined>,
  threshold?: number,
  onUsage?: (usage: Usage) => void
): Promise<Pick<Verdict, 'pass' | 'findings'>> => {
  try {
    const { answer } = await decide({
      url: env.BOTHUB_DECIDE_URL || defaultDecideUrl,
      model: env.BOTHUB_DECIDE_MODEL || defaultDecideModel,
      llm: endpointOf(env),
      onUsage,
      state,
      questions: { answer: { type: 'noul', instructions: question } },
    });
    const against = threshold === undefined ? 'no threshold' : `threshold ${threshold}`;
    return {
      pass: threshold === undefined || answer.noul >= threshold,
      findings: `Probability of yes ${answer.noul.toFixed(3)}, ${against}. ${question}`,
    };
  } catch (e) {
    return { pass: false, findings: e instanceof Error ? e.message : String(e) };
  }
};
