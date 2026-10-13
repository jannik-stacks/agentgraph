import { parse } from 'yaml';
import type { SourceFile } from './config.ts';
import type { Price } from './usage.ts';

/** A price table: model aliases to upstream model ids, and list prices per upstream model in USD per million tokens. */
export type PriceTable = { aliases?: Record<string, string>; models?: Record<string, Price> };

type ModelInfo = {
  model_name?: string;
  litellm_params?: { model?: string };
  model_info?: { input_cost_per_token?: number; output_cost_per_token?: number; cache_read_input_token_cost?: number };
};

const bare = (model: string) => model.split('/').at(-1) ?? model;

const modelList = (source: string): ModelInfo[] => {
  try {
    const list = (parse(source) as { model_list?: unknown } | null)?.model_list;
    return Array.isArray(list) ? list : [];
  } catch {
    return [];
  }
};

/** The model aliases a proxy serves: every `model_name` in the `litellm*.yaml` configs among `files`, sorted. */
export const modelNames = (files: SourceFile[]) =>
  [
    ...new Set(
      files
        .filter(f => /litellm[^/]*\.ya?ml$/.test(f.path))
        .flatMap(f => modelList(f.source).flatMap(m => (typeof m?.model_name === 'string' ? [m.model_name] : [])))
    ),
  ].sort();

const fromProxy = async (env: Record<string, string | undefined>, fetcher: typeof fetch) => {
  const base = env.BOTHUB_LLM_BASE_URL;
  const key = env.BOTHUB_LLM_API_KEY ?? env.LITELLM_MASTER_KEY;
  if (!base || !key) return [];
  try {
    const response = await fetcher(`${base.replace(/\/v1\/?$/, '')}/model/info`, {
      headers: { authorization: `Bearer ${key}` },
      signal: AbortSignal.timeout(2000),
    });
    if (!response.ok) return [];
    return ((await response.json()) as { data?: ModelInfo[] }).data ?? [];
  } catch {
    return [];
  }
};

/**
 * Estimated list prices keyed by model alias and by upstream model id. An alias resolves through
 * `BOTHUB_MODEL_<ALIAS>`, then the model proxy's `/model/info` when its URL and key are in `env`, then the table's
 * `aliases`. A price the proxy reports wins over the table; the table covers models the proxy reports at $0, like a
 * subscription. Results are cached for `ttlMs`.
 */
export const loadPrices = ({
  file,
  env = process.env,
  fetcher = fetch,
  ttlMs = 5 * 60_000,
}: {
  file?: string | undefined;
  env?: Record<string, string | undefined>;
  fetcher?: typeof fetch;
  ttlMs?: number;
}) => {
  let cached: { at: number; value: Promise<Record<string, Price & { model: string }>> } | undefined;
  const load = async () => {
    // Loaded on first use so the studio can import this module in the browser.
    const { readFile } = process.getBuiltinModule('node:fs/promises');
    const table: PriceTable = file ? JSON.parse(await readFile(file, 'utf8').catch(() => '{}')) : {};
    const models = table.models ?? {};
    const listed = (model: string) => models[model] ?? models[bare(model)];
    const prices: Record<string, Price & { model: string }> = {};
    const aliases = { ...table.aliases };
    for (const info of await fromProxy(env, fetcher)) {
      const alias = info.model_name;
      const model = info.litellm_params?.model;
      if (!alias || !model) continue;
      aliases[alias] ??= model;
      const m = info.model_info;
      if (m?.input_cost_per_token || m?.output_cost_per_token)
        prices[alias] = {
          model,
          input: (m.input_cost_per_token ?? 0) * 1e6,
          output: (m.output_cost_per_token ?? 0) * 1e6,
          ...(m.cache_read_input_token_cost !== undefined && { cached: m.cache_read_input_token_cost * 1e6 }),
        };
    }
    for (const [name, value] of Object.entries(env))
      if (name.startsWith('BOTHUB_MODEL_') && value) aliases[name.slice(13).toLowerCase()] = value;
    for (const [alias, model] of Object.entries(aliases)) {
      const price = listed(model);
      if (!prices[alias] && price) prices[alias] = { ...price, model };
    }
    for (const [model, price] of Object.entries(models)) prices[model] ??= { ...price, model };
    return prices;
  };
  return () => {
    if (!cached || Date.now() - cached.at > ttlMs) cached = { at: Date.now(), value: load() };
    return cached.value;
  };
};
