import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { gunzipSync } from 'node:zlib';

export const priceTable = fileURLToPath(new URL('../infra/local/prices.json.gz', import.meta.url));
const aliasFile = fileURLToPath(new URL('../infra/local/aliases.json', import.meta.url));

type ListPrice = Partial<
  Record<
    | 'input_cost_per_token'
    | 'output_cost_per_token'
    | 'cache_read_input_token_cost'
    | 'cache_creation_input_token_cost',
    number
  >
>;

export type Prices = { table: Record<string, ListPrice>; aliases: Record<string, string> };

export type TokenCounts = Record<'input' | 'cacheRead' | 'cacheWrite' | 'output', number>;

export const readPrices = (path = priceTable): Prices => {
  const raw = readFileSync(path);
  return {
    table: JSON.parse((path.endsWith('.gz') ? gunzipSync(raw) : raw).toString('utf8')),
    aliases: JSON.parse(readFileSync(aliasFile, 'utf8')),
  };
};

const isPriced = (p?: ListPrice): p is ListPrice =>
  p?.input_cost_per_token !== undefined && p.output_cost_per_token !== undefined;

const bare = (name: string) => name.split('/').at(-1)!;

const found = new WeakMap<Prices, Map<string, ListPrice | undefined>>();

const findListPrice = (prices: Prices, model: string) => {
  const cache = found.get(prices) ?? new Map<string, ListPrice | undefined>();
  found.set(prices, cache);
  if (cache.has(model)) return cache.get(model);
  const upstream = prices.aliases[model] ?? prices.aliases[bare(model)] ?? model;
  const name = bare(upstream);
  const listed = Object.entries(prices.table).flatMap(([key, p]) =>
    isPriced(p) && (key.endsWith(`/${name}`) || key.endsWith(`.${name}`)) ? [p] : []
  );
  const key = (p: ListPrice) => `${p.input_cost_per_token}/${p.output_cost_per_token}`;
  const count = (p: ListPrice) => listed.filter(q => key(q) === key(p)).length;
  const common = listed.reduce<ListPrice | undefined>(
    (best, p) => (best && count(best) >= count(p) ? best : p),
    undefined
  );
  const price = [model, upstream, name].map(k => prices.table[k]).find(isPriced) ?? common;
  cache.set(model, price);
  return price;
};

export const isModelPriced = (prices: Prices, model: string) => findListPrice(prices, model) !== undefined;

export const getListPriceUsd = (prices: Prices, models: string[], tokens: TokenCounts, uncached = false) => {
  const p = models.map(model => findListPrice(prices, model)).find(Boolean);
  if (!p) return undefined;
  const input = p.input_cost_per_token!;
  const read = uncached ? input : (p.cache_read_input_token_cost ?? input);
  const write = uncached ? input : (p.cache_creation_input_token_cost ?? input);
  return (
    tokens.input * input +
    tokens.cacheRead * read +
    tokens.cacheWrite * write +
    tokens.output * p.output_cost_per_token!
  );
};
