import { getMean } from '../../../src/stats.ts';
import type { BenchRow as Row } from './data.ts';

export const roughBelow = 10;

export const defaultBenchBy = ['harness', 'model', 'arm', 'engine', 'graph', 'set'];

export const defaultBenchScoreWeights = { test: 0.5, judge: 0.35, suite: 0.15, crit: 0.1, help: 0.1 };
export const presets: Record<string, typeof defaultBenchScoreWeights> = {
  composite: defaultBenchScoreWeights,
  'hidden tests only': { test: 1, judge: 0, suite: 0, crit: 0, help: 0 },
  'judges only': { test: 0, judge: 1, suite: 0, crit: 0, help: 0 },
};

export const cost = (row: Row, cacheOff = false) => (cacheOff ? row.usdUncached : row.usd);

export const quality = (row: Row, w: typeof defaultBenchScoreWeights, judges?: string[], human?: Row) => {
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
  const bad = (r?: Row) => (r ? r.findings.critical + r.findings.high : 0);
  const crit = Math.min(1, Math.max(0, bad(row) - bad(human)) / 3);
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

export const splitBy = <T>(xs: T[], key: (x: T) => string) =>
  xs.reduce((m, x) => m.set(key(x), [...(m.get(key(x)) ?? []), x]), new Map<string, T[]>());

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
  const baseline = (r: Row) =>
    JSON.stringify([
      r.case,
      r.repeat,
      Object.entries(r.labels)
        .filter(([k]) => k !== 'arm' && k !== 'graph')
        .toSorted(([a], [b]) => a.localeCompare(b)),
    ]);
  const humans = new Map(rows.filter(r => r.labels.arm === 'human').map(r => [baseline(r), r]));
  const keys = [...new Set([...(o.by ?? defaultBenchBy), ...(o.color ? [o.color] : []), 'set', 'tests'])];
  const byPoint = splitBy(
    rows.filter(
      r =>
        r.labels.arm !== 'human' &&
        Object.entries(o.where ?? {}).every(([k, vs]) => !vs.length || vs.includes(r.labels[k]!))
    ),
    r => JSON.stringify(keys.map(k => [k, r.labels[k] ?? null]))
  );
  return [...byPoint].map(([key, all]) => {
    const scored = all.flatMap(r => {
      const y = r.infra ? (o.infraZero ? 0 : undefined) : quality(r, o.w, o.judges, humans.get(baseline(r)));
      return y === undefined ? [] : [{ row: r, y, x: o.x(r) }];
    });
    const kept = scored.map(s => s.row);
    const cases = [...splitBy(scored, s => s.row.case).values()];
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
