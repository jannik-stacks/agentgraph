import type { AgentEvent } from './types.ts';

/** What makes model calls: the harness's agent loop, and bothub's summarizer, recall, decider and decide checks. */
export const sources = ['harness', 'summarizer', 'recall', 'decider', 'decide-check'] as const;
export type Source = (typeof sources)[number];

/** One model call, as a run event. */
export type Usage = Extract<AgentEvent, { type: 'usage' }>;

/**
 * Totals over a run's events. `in` counts every input token of every model call, `cached` included; `usd` is what was
 * reported, which is 0 for models without a price. `ms` sums the time of the calls bothub timed. `toolChars` sums the
 * arguments and results of tool calls. `errors` counts error events. `sources` splits the model calls by what made
 * them, each with the model it last used and its failed calls as `errors`.
 */
export type Tally = {
  calls: number;
  in: number;
  out: number;
  cached: number;
  reasoning: number;
  usd: number;
  ms: number;
  tools: number;
  toolChars: number;
  errors: number;
  sources: Partial<
    Record<
      Source,
      Pick<Tally, 'calls' | 'in' | 'out' | 'cached' | 'reasoning' | 'usd' | 'ms' | 'errors'> & { model?: string }
    >
  >;
};

/** A list price in USD per million tokens. `cached` is the price of input read from the prompt cache. */
export type Price = { input: number; output: number; cached?: number };

export const emptyTally = (): Tally => ({
  calls: 0,
  in: 0,
  out: 0,
  cached: 0,
  reasoning: 0,
  usd: 0,
  ms: 0,
  tools: 0,
  toolChars: 0,
  errors: 0,
  sources: {},
});

const part = (tally: Tally, source: Source) =>
  (tally.sources[source] ??= { calls: 0, in: 0, out: 0, cached: 0, reasoning: 0, usd: 0, ms: 0, errors: 0 });

/** Characters of a tool argument or result as sent to the model. */
export const chars = (value: unknown) =>
  value === undefined ? 0 : typeof value === 'string' ? value.length : (JSON.stringify(value)?.length ?? 0);

/** A rough token count for text the model reads, about four characters per token. */
export const tokensOf = (characters: number) => Math.ceil(characters / 4);

/** Adds one event to `tally` in place. A harness total on `end` replaces the sum of its per-call costs. */
export const count = (tally: Tally, event: AgentEvent) => {
  switch (event.type) {
    case 'usage': {
      const by = part(tally, event.source ?? 'harness');
      for (const t of [tally, by]) {
        t.calls++;
        t.in += event.inputTokens;
        t.out += event.outputTokens;
        t.cached += event.cachedInputTokens ?? 0;
        t.reasoning += event.reasoningTokens ?? 0;
        t.usd += event.costUsd ?? 0;
        t.ms += event.ms ?? 0;
      }
      if (event.error) by.errors++;
      if (event.model) by.model = event.model;
      break;
    }
    case 'tool_call':
      tally.tools++;
      tally.toolChars += chars(event.input);
      break;
    case 'tool_result':
      tally.toolChars += chars(event.output);
      break;
    case 'end': {
      if (event.costUsd === undefined) break;
      const harness = part(tally, 'harness');
      const more = Math.max(0, event.costUsd - harness.usd);
      harness.usd += more;
      tally.usd += more;
      break;
    }
    case 'error':
      tally.errors++;
      break;
  }
  return tally;
};

export const tally = (events: Iterable<AgentEvent>) => {
  const total = emptyTally();
  for (const event of events) count(total, event);
  return total;
};

const add = (into: Record<string, unknown>, from: object) => {
  for (const [key, value] of Object.entries(from))
    if (typeof value === 'number') into[key] = ((into[key] as number | undefined) ?? 0) + value;
};

/** Sums tallies source by source: a job's attempts and checks, everything an event started, or a day. */
export const sum = (tallies: Iterable<Tally>) => {
  const total = emptyTally();
  for (const t of tallies) {
    add(total, t);
    for (const [source, from] of Object.entries(t.sources ?? {})) {
      const into = part(total, source as Source);
      add(into, from);
      if (from.model) into.model = from.model;
    }
  }
  return total;
};

/** What `tokens` would cost at `price`: uncached input, cached input, then output and reasoning at the output price. */
export const estimate = (tokens: Pick<Tally, 'in' | 'out' | 'cached' | 'reasoning'>, price: Price | undefined) =>
  price &&
  ((tokens.in - tokens.cached) * price.input +
    tokens.cached * (price.cached ?? price.input) +
    (tokens.out + tokens.reasoning) * price.output) /
    1e6;

/**
 * Times one model call to `model` and reports it to `onUsage`: with the tokens `call` read from the response, or as a
 * failed call without tokens when it throws.
 */
export const meter = async <T>(
  model: string,
  onUsage: ((usage: Usage) => void) | undefined,
  call: () => Promise<{
    value: T;
    tokens?: Partial<Pick<Usage, 'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'reasoningTokens' | 'costUsd'>>;
  }>
) => {
  const started = performance.now();
  const report = (fields: Partial<Usage>) =>
    onUsage?.({
      type: 'usage',
      inputTokens: 0,
      outputTokens: 0,
      ...fields,
      model,
      ms: Math.round(performance.now() - started),
    });
  try {
    const { value, tokens } = await call();
    report({ ...tokens });
    return value;
  } catch (e) {
    report({ error: true });
    throw e;
  }
};
