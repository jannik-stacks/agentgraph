import type { AgentEvent } from './types.ts';

/**
 * Totals over a run's events. `in` counts every input token of every model call, `cached` included; `usd` is what the
 * harness reported, which is 0 for models it has no price for. `toolChars` sums the arguments and results of tool
 * calls.
 */
export type Tally = {
  calls: number;
  in: number;
  out: number;
  cached: number;
  reasoning: number;
  usd: number;
  tools: number;
  toolChars: number;
  errors: number;
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
  tools: 0,
  toolChars: 0,
  errors: 0,
});

/** Characters of a tool argument or result as sent to the model. */
export const chars = (value: unknown) =>
  value === undefined ? 0 : typeof value === 'string' ? value.length : (JSON.stringify(value)?.length ?? 0);

/** A rough token count for text the model reads, about four characters per token. */
export const tokensOf = (characters: number) => Math.ceil(characters / 4);

/** Adds one event to `tally` in place. A harness total on `end` replaces the sum of per-call costs. */
export const count = (tally: Tally, event: AgentEvent) => {
  switch (event.type) {
    case 'usage':
      tally.calls++;
      tally.in += event.inputTokens;
      tally.out += event.outputTokens;
      tally.cached += event.cachedInputTokens ?? 0;
      tally.reasoning += event.reasoningTokens ?? 0;
      tally.usd += event.costUsd ?? 0;
      break;
    case 'tool_call':
      tally.tools++;
      tally.toolChars += chars(event.input);
      break;
    case 'tool_result':
      tally.toolChars += chars(event.output);
      break;
    case 'end':
      if (event.costUsd !== undefined) tally.usd = Math.max(tally.usd, event.costUsd);
      break;
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

/** Sums tallies, for a job's attempts and checks or for everything an event started. */
export const sum = (tallies: Iterable<Tally>) => {
  const total = emptyTally();
  for (const t of tallies) for (const key of Object.keys(total) as (keyof Tally)[]) total[key] += t[key];
  return total;
};

/** What `tokens` would cost at `price`: uncached input, cached input, then output and reasoning at the output price. */
export const estimate = (tokens: Pick<Tally, 'in' | 'out' | 'cached' | 'reasoning'>, price: Price | undefined) =>
  price &&
  ((tokens.in - tokens.cached) * price.input +
    tokens.cached * (price.cached ?? price.input) +
    (tokens.out + tokens.reasoning) * price.output) /
    1e6;
