import { getMean } from '../../../src/stats.ts';
import { getQuantile } from '../results/result.ts';
import type { BenchRow as Row } from './data.ts';

export const roughBelow = 10;

export const formatMinutes = (m: number) =>
  m < 1 ? `${Math.round(m * 60)} s` : m < 60 ? `${m.toFixed(1)} min` : `${(m / 60).toFixed(1)} h`;

export const formatLabel = (v: string | undefined) =>
  v === undefined ? '(missing)' : /^[0-9a-f]{7,}$/.test(v) ? v.slice(0, 6) : v;

export const defaultBenchBy = ['harness', 'model', 'arm', 'engine', 'graph', 'set'];

export const defaultBenchScoreWeights = { test: 0.5, judge: 0.35, suite: 0.15, crit: 0.1, help: 0.1 };
export const presets: Record<string, typeof defaultBenchScoreWeights> = {
  composite: defaultBenchScoreWeights,
  'hidden tests only': { test: 1, judge: 0, suite: 0, crit: 0, help: 0 },
  'judges only': { test: 0, judge: 1, suite: 0, crit: 0, help: 0 },
};

export const cost = (row: Row, cacheOff = false) => (cacheOff ? row.usdUncached : row.usd);

const countBad = (f?: Row['findings']) => (f ? f.critical + f.high : 0);

export const quality = (row: Row, w: typeof defaultBenchScoreWeights, judges?: string[]) => {
  if (row.outcome === 'no-change') return 0;
  const votes = Object.entries(row.vsHuman).flatMap(([j, v]) => (!judges || judges.includes(j) ? [v] : []));
  const parts: [number, number][] = [
    ...(row.hidden === undefined ? [] : [[w.test, row.hiddenShare ?? row.hidden] as [number, number]]),
    ...(votes.length ? [[w.judge, Math.min(1, 2 * getMean(votes))] as [number, number]] : []),
    ...(row.suite === undefined && row.typecheck === undefined
      ? []
      : [[w.suite, (row.suite ?? 1) * (row.typecheck ?? 1)] as [number, number]]),
  ];
  const weight = parts.reduce((a, [wt]) => a + wt, 0);
  if (!weight) return undefined;
  const base = parts.reduce((a, [wt, v]) => a + wt * v, 0) / weight;
  const crit = Math.min(1, Math.max(0, countBad(row.findings) - countBad(row.against)) / 3);
  return base - w.crit * crit - w.help * Math.min(1, row.answers);
};

export const random = (seed: number) => {
  let state = seed;
  return () => {
    state = (state + 0x6d2b79f5) | 0;
    let t = Math.imul(state ^ (state >>> 15), 1 | state);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
};

export const getRowKey = (row: Row) => row.run;

const getSpread = (xs: number[]) => ({
  median: getQuantile(xs, 0.5),
  middle: [getQuantile(xs, 0.25), getQuantile(xs, 0.75)] as const,
  range: [Math.min(...xs), Math.max(...xs)] as const,
});

export const getQualitySpread = (scored: readonly { row: { case: string }; y: number }[]) => {
  const cases = [...Map.groupBy(scored, s => s.row.case).values()].map(ss => getMean(ss.map(s => s.y)));
  return { caseMeans: cases, cases: getSpread(cases), runs: getSpread(scored.map(s => s.y)) };
};

/** @internal */
export const bootstrap = (cases: { y: number; x: number }[][], draws = 1000, seed = 1) => {
  const stat = (cs: { y: number; x: number }[][]) => {
    const per = cs.map(rs => [getMean(rs.map(r => r.y)), getMean(rs.map(r => r.x))] as const);
    return [getMean(per.map(p => p[0])), getMean(per.map(p => p[1]))] as const;
  };
  const next = random(seed);
  const pick = <T>(xs: T[]) => xs.map(() => xs[Math.floor(next() * xs.length)]!);
  const samples = Array.from({ length: draws }, () => stat(pick(cases).map(pick)));
  const point = stat(cases);
  const ci = (k: 0 | 1): [number, number] => {
    const sorted = samples.map(s => s[k]).toSorted((a, b) => a - b);
    return [sorted[Math.floor(draws * 0.025)] ?? point[k], sorted[Math.floor(draws * 0.975)] ?? point[k]];
  };
  return { y: point[0], x: point[1], yCi: ci(0), xCi: ci(1) };
};

export const isBenchMatch = (row: Row, where: Record<string, string[]>) =>
  !['human', 'base'].includes(row.labels.arm ?? '') &&
  Object.entries(where).every(([key, values]) => values.includes(row.labels[key]!));

export const summarise = (
  rows: readonly Row[],
  o: {
    w: typeof defaultBenchScoreWeights;
    x: (row: Row) => number;
    judges?: string[];
    infraZero?: boolean;
    where?: Record<string, string[]>;
    by?: string[];
    color?: string;
  }
) => {
  const keys = [...new Set([...(o.by ?? defaultBenchBy), ...(o.color ? [o.color] : []), 'set', 'tests'])];
  const byPoint = Map.groupBy(
    rows.filter(r => isBenchMatch(r, o.where ?? {})),
    r => JSON.stringify(keys.map(k => [k, r.labels[k] ?? null]))
  );
  return [...byPoint].map(([key, all]) => {
    const scored = all.flatMap(r => {
      const y = r.infra ? (o.infraZero ? 0 : undefined) : quality(r, o.w, o.judges);
      return y === undefined ? [] : [{ row: r, y, x: o.x(r) }];
    });
    const kept = scored.map(s => s.row);
    const cases = [...Map.groupBy(scored, s => s.row.case).values()];
    const judged = kept.flatMap(r => {
      const votes = Object.entries(r.vsHuman).flatMap(([j, v]) => (!o.judges || o.judges.includes(j) ? [v] : []));
      return votes.length ? [getMean(votes)] : [];
    });
    const tested = kept.flatMap(r => (r.hidden === undefined ? [] : [r.hidden]));
    return {
      key,
      labels: Object.fromEntries(keys.flatMap(k => (all[0]!.labels[k] === undefined ? [] : [[k, all[0]!.labels[k]!]]))),
      judgeOnly: all[0]!.labels.tests === 'judge-only',
      n: cases.length,
      repeats: kept.length,
      completion: all.filter(r => !r.infra).length / all.length,
      hidden: tested.length ? getMean(tested) : undefined,
      vsHuman: judged.length ? getMean(judged) : undefined,
      minutes: getMean(kept.map(r => r.minutes)),
      ...bootstrap(cases),
      perCase: scored,
    };
  });
};

export const frontier = (points: { key: string; x: number; y: number; judgeOnly?: boolean }[]) => {
  let best = -Infinity;
  return points
    .filter(p => !p.judgeOnly)
    .toSorted((a, b) => a.x - b.x || b.y - a.y)
    .flatMap(p => (p.y > best ? ((best = p.y), [p.key]) : []));
};
