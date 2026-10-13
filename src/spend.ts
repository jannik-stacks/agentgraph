import { createHash } from 'node:crypto';
import type { Store } from './store.ts';
import type { Tally, Usage } from './usage.ts';

type Totals = Pick<Tally, 'calls' | 'in' | 'out' | 'usd'>;

/** One row of LiteLLM's `/spend/logs?summarize=false`; `api_key` is the SHA-256 of the key. */
type SpendLog = {
  api_key?: string;
  startTime?: string;
  prompt_tokens?: number;
  completion_tokens?: number;
  spend?: number;
};

const day = 24 * 60 * 60 * 1000;
const keyVar = 'BOTHUB_LLM_API_KEY';
const zero = (): Totals => ({ calls: 0, in: 0, out: 0, usd: 0 });
const add = (into: Totals, from: Totals) => {
  into.calls += from.calls;
  into.in += from.in;
  into.out += from.out;
  into.usd += from.usd;
};
const hash = (key: string) => createHash('sha256').update(key).digest('hex');

/**
 * Compares the model calls bothub recorded between `since` and `until` (ms) with the model proxy's own spend logs,
 * key by key. A bot's calls count against its `BOTHUB_LLM_API_KEY_<BOT>` from `env`, or against the shared
 * `BOTHUB_LLM_API_KEY` (`shared`) when it has none; decide checks always use the shared key. `missing` is what the
 * proxy logged beyond what bothub recorded. Calls that went straight to Ollama never reach the proxy and are listed per
 * bot under `direct`; proxy rows from keys no bot holds, such as the master key, are `other`. Reads the logs from
 * LiteLLM at `BOTHUB_LLM_BASE_URL` with `LITELLM_MASTER_KEY`.
 *
 * @throws when `env` lacks the proxy URL or master key, or the proxy answers with an error.
 */
export const compareSpend = async ({
  store,
  env,
  since,
  until = Date.now(),
  fetcher = fetch,
}: {
  store: Store;
  env: Record<string, string | undefined>;
  since: number;
  until?: number;
  fetcher?: typeof fetch;
}) => {
  const base = env.BOTHUB_LLM_BASE_URL?.replace(/\/v1\/?$/, '').replace(/\/+$/, '');
  const master = env.LITELLM_MASTER_KEY;
  if (!base || !master) throw new Error('comparing spend needs BOTHUB_LLM_BASE_URL and LITELLM_MASTER_KEY');
  const within = (ts: string | undefined) => {
    const at = ts ? Date.parse(ts) : NaN;
    return at >= since && at <= until;
  };

  const label = (name: string) =>
    name === keyVar
      ? 'shared'
      : name
          .slice(keyVar.length + 1)
          .toLowerCase()
          .replaceAll('_', '-');
  const owners = new Map<string, string>();
  for (const [name, value] of Object.entries(env))
    if (value && (name === keyVar || name.startsWith(`${keyVar}_`))) owners.set(hash(value), label(name));
  const keyOf = (bot: string | undefined, usage: Usage) => {
    const name = `${keyVar}_${bot?.toUpperCase().replaceAll('-', '_')}`;
    return usage.source === 'decide-check' || !bot || !env[name] ? 'shared' : label(name);
  };

  const bothub = new Map<string, Totals>();
  const direct = new Map<string, Totals>();
  const bucket = (map: Map<string, Totals>, key: string) => map.get(key) ?? map.set(key, zero()).get(key)!;
  for (const run of await store.list()) {
    const started = run.startedAt ? Date.parse(run.startedAt) : NaN;
    if (!(started >= since - day && started <= until)) continue;
    for (const { ts, event } of await store.events(run.id)) {
      if (event.type !== 'usage' || !within(ts)) continue;
      const totals = {
        calls: 1,
        in: event.inputTokens,
        out: event.outputTokens + (event.reasoningTokens ?? 0),
        usd: event.costUsd ?? 0,
      };
      add(event.direct ? bucket(direct, run.bot ?? 'none') : bucket(bothub, keyOf(run.bot, event)), totals);
    }
  }

  const query = new URLSearchParams({
    start_date: new Date(since).toISOString().slice(0, 10),
    end_date: new Date(until + day).toISOString().slice(0, 10),
    summarize: 'false',
  });
  const response = await fetcher(`${base}/spend/logs?${query}`, { headers: { authorization: `Bearer ${master}` } });
  if (!response.ok) throw new Error(`spend logs: ${response.status}: ${(await response.text()).slice(0, 200)}`);
  const logs = (await response.json()) as SpendLog[];
  const proxy = new Map<string, Totals>();
  const other = zero();
  for (const log of logs) {
    if (!within(log.startTime)) continue;
    const totals = { calls: 1, in: log.prompt_tokens ?? 0, out: log.completion_tokens ?? 0, usd: log.spend ?? 0 };
    const owner = log.api_key ? owners.get(log.api_key) : undefined;
    add(owner ? bucket(proxy, owner) : other, totals);
  }

  const keys = [...new Set([...bothub.keys(), ...proxy.keys()])].sort().map(key => {
    const recorded = bothub.get(key) ?? zero();
    const logged = proxy.get(key) ?? zero();
    return {
      key,
      bothub: recorded,
      proxy: logged,
      missing: {
        calls: logged.calls - recorded.calls,
        in: logged.in - recorded.in,
        out: logged.out - recorded.out,
        usd: logged.usd - recorded.usd,
      },
    };
  });
  return {
    since: new Date(since).toISOString(),
    until: new Date(until).toISOString(),
    keys,
    direct: Object.fromEntries([...direct].sort(([a], [b]) => a.localeCompare(b))),
    other,
  };
};
