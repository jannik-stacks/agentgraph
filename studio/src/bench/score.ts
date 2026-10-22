import type { rowsOf } from '../../../bin/bench.ts';

type Row = ReturnType<typeof rowsOf>[number];
type Tokens = Row['tokens'][string];

export const defaults = { test: 0.5, judge: 0.35, suite: 0.15, crit: 0.1, help: 0.1 };
export const presets: Record<string, typeof defaults> = {
  composite: defaults,
  'hidden tests only': { test: 1, judge: 0, suite: 0, crit: 0, help: 0 },
  'judges only': { test: 0, judge: 1, suite: 0, crit: 0, help: 0 },
};

/** List prices in USD per million tokens by upstream model, and the proxy's aliases for them. */
type Prices = {
  asOf?: string;
  aliases?: Record<string, string>;
  models?: Record<string, { input: number; output: number; cached?: number; cacheWrite?: number }>;
};

/** The notional USD of `tokens`; `cacheOff` prices cache reads and writes as input. */
export const price = (tokens: Record<string, Tokens>, prices: Prices, cacheOff = false) =>
  Object.entries(tokens).reduce((sum, [model, t]) => {
    const upstream = prices.aliases?.[model] ?? model;
    const p = prices.models?.[upstream] ?? prices.models?.[upstream.split('/').at(-1)!];
    if (!p) return sum;
    const read = cacheOff ? p.input : (p.cached ?? p.input);
    const write = cacheOff ? p.input : (p.cacheWrite ?? p.input);
    return sum + (t.input * p.input + t.cacheRead * read + t.cacheWrite * write + t.output * p.output) / 1e6;
  }, 0);

/** The row's cost: its tokens priced, else what the harness reported. */
export const cost = (row: Row, prices: Prices, cacheOff = false) =>
  Object.keys(row.tokens).length ? price(row.tokens, prices, cacheOff) : (row.usd ?? 0);

const mean = (xs: number[]) => (xs.length ? xs.reduce((a, x) => a + x, 0) / xs.length : 0);

/** Quality on a fixed scale where 0 is nothing useful and 1 is the human; `human` is the human row of the same case. */
export const quality = (row: Row, w: typeof defaults, judges?: string[], human?: Row) => {
  if (row.outcome === 'no-change') return 0;
  const votes = Object.entries(row.vsHuman).flatMap(([j, v]) => (!judges || judges.includes(j) ? [v] : []));
  const parts: [number, number][] = [
    ...(row.hidden === undefined ? [] : [[w.test, row.hidden] as [number, number]]),
    ...(votes.length ? [[w.judge, 2 * mean(votes)] as [number, number]] : []),
    ...(row.suite === undefined && row.typecheck === undefined
      ? []
      : [[w.suite, (row.suite ?? 1) * (row.typecheck ?? 1)] as [number, number]]),
  ];
  const weight = parts.reduce((a, [wt]) => a + wt, 0);
  const base = weight ? parts.reduce((a, [wt, v]) => a + wt * v, 0) / weight : 0;
  const bad = (r?: Row) => (r ? r.findings.critical + r.findings.high : 0);
  const crit = Math.min(1, Math.max(0, bad(row) - bad(human)) / 3);
  return base - w.crit * crit - w.help * Math.min(1, row.answers);
};

/** A seeded generator, so a redraw resamples the same way. */
const random = (seed: number) => () => {
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
};

const group = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map<string, T[]>());

/** Mean over cases of the mean over repeats, of `y` and `x`, and their 95% interval from a two-level bootstrap. */
export const bootstrap = (cases: { y: number; x: number }[][], draws = 1000, seed = 1) => {
  const stat = (cs: { y: number; x: number }[][]) => {
    const per = cs.map(rs => [mean(rs.map(r => r.y)), mean(rs.map(r => r.x))] as const);
    return [mean(per.map(p => p[0])), mean(per.map(p => p[1]))] as const;
  };
  const next = random(seed);
  const pick = <T>(xs: T[]) => xs.map(() => xs[Math.floor(next() * xs.length)]!);
  const samples = Array.from({ length: draws }, () => stat(pick(cases).map(pick)));
  const point = stat(cases);
  const ci = (k: 0 | 1): [number, number] => {
    const sorted = samples.map(s => s[k]).sort((a, b) => a - b);
    return [sorted[Math.floor(draws * 0.025)] ?? point[k], sorted[Math.floor(draws * 0.975)] ?? point[k]];
  };
  return { y: point[0], x: point[1], yCi: ci(0), xCi: ci(1) };
};

/** One summary per point of the bot rows: quality and x with their intervals, cases, repeats and completion. */
export const summarise = (
  rows: Row[],
  o: { w: typeof defaults; x: (row: Row) => number; judges?: string[]; infraZero?: boolean }
) => {
  const humans = new Map(rows.filter(r => r.point.includes('/human@')).map(r => [`${r.point}|${r.case}`, r]));
  const humanOf = (r: Row) => humans.get(`${r.point.replace(/\/\w+@/, '/human@')}|${r.case}`);
  const byPoint = group(
    rows.filter(r => !r.point.includes('/human@')),
    r => r.point
  );
  return [...byPoint].map(([key, all]) => {
    const kept = all.filter(r => o.infraZero || !r.infra);
    const scored = kept.map(r => ({
      row: r,
      y: r.infra ? 0 : quality(r, o.w, o.judges, humanOf(r)),
      x: o.x(r),
    }));
    const cases = [...group(scored, s => s.row.case).values()];
    const judged = kept.flatMap(r => {
      const votes = Object.entries(r.vsHuman).flatMap(([j, v]) => (!o.judges || o.judges.includes(j) ? [v] : []));
      return votes.length ? [mean(votes)] : [];
    });
    const tested = kept.flatMap(r => (r.hidden === undefined ? [] : [r.hidden]));
    return {
      key,
      n: cases.length,
      repeats: kept.length,
      completion: all.filter(r => !r.infra).length / all.length,
      hidden: tested.length ? mean(tested) : undefined,
      vsHuman: judged.length ? mean(judged) : undefined,
      minutes: mean(kept.map(r => r.minutes)),
      ...bootstrap(cases),
      perCase: scored,
    };
  });
};

/** The keys of the points no cheaper point matches in quality, cheapest first. */
export const frontier = (points: { key: string; x: number; y: number }[]) => {
  let best = -Infinity;
  return points.toSorted((a, b) => a.x - b.x || b.y - a.y).flatMap(p => (p.y > best ? ((best = p.y), [p.key]) : []));
};
