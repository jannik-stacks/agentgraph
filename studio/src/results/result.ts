import type { BenchRow } from '../../../bench/runs.ts';
import type { ResultSheet } from '../../../src/results.ts';
import { formatNumber } from '../runs/trace.ts';

export type CheckField = (typeof ResultSheet.Type.fields)[number];
export type RunResults = (typeof ResultSheet.Type.runs)[number];
export type RunResult = RunResults['results'][string];

export const readFieldValue = (run: RunResults, f: Pick<CheckField, 'check' | 'field'>) => {
  const r = run.results[f.check];
  if (!r || r.empty) return undefined;
  const v = f.field === 'share' && r.value?.share === undefined ? r.share : r.value?.[f.field];
  return typeof v === 'boolean' ? +v : v;
};

const minutes = (m: number) =>
  m < 60 ? `${formatNumber(Math.round(m * 10) / 10)} min` : `${Math.floor(m / 60)} h ${Math.round(m % 60)} min`;

export const formatResultValue = (field: Pick<CheckField, 'unit' | 'type'>, v: unknown): string => {
  if (typeof v !== 'number') return v === undefined ? '' : String(v);
  if (field.type === 'boolean') return `${Math.round(v * 100)}%`;
  switch (field.unit) {
    case 'usd':
      return v > 0 && v < 0.01 ? '<$0.01' : `$${v.toFixed(2)}`;
    case 'minutes':
      return minutes(v);
    case 'seconds':
      return v < 60 ? `${formatNumber(v)} s` : minutes(v / 60);
    case 'tokens':
      return formatNumber(Math.round(v));
    case 'share':
      return `${Math.round(v * 100)}%`;
    default:
      return formatNumber(v);
  }
};

export const getQuantile = (xs: number[], q: number) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const i = (sorted.length - 1) * q;
  const lo = sorted[Math.floor(i)] ?? 0;
  return lo + ((sorted[Math.ceil(i)] ?? lo) - lo) * (i - Math.floor(i));
};

export const splitRunsByAxis = (runs: RunResults[], axis: string) => {
  const groups = new Map<string, RunResults[]>();
  const sorted = runs.toSorted((a, b) => a.at.localeCompare(b.at));
  sorted.forEach((run, i) => {
    const key =
      axis === 'time'
        ? run.at.slice(0, 10)
        : axis === 'order'
          ? String(Math.floor(i / 10) * 10)
          : (run.axes[axis] ?? 'none');
    groups.set(key, [...(groups.get(key) ?? []), run]);
  });
  return groups;
};

export const getFieldSummary = (runs: RunResults[], field: CheckField, trend = 'time') => {
  const live = runs.filter(r => !r.dead);
  const points = live.flatMap(run => {
    const v = readFieldValue(run, field);
    return typeof v === 'number' ? [{ run, v }] : [];
  });
  const values = points.map(p => p.v);
  const outside = points.filter(
    ({ v }) =>
      (field.limit?.maximum !== undefined && v > field.limit.maximum) ||
      (field.limit?.minimum !== undefined && v < field.limit.minimum)
  );
  const steps = [
    ...splitRunsByAxis(
      points.map(p => p.run),
      trend
    ).values(),
  ].map(group =>
    getQuantile(
      group.map(run => readFieldValue(run, field) as number),
      0.5
    )
  );
  return {
    points,
    values,
    median: values.length ? getQuantile(values, 0.5) : undefined,
    low: Math.min(...values),
    high: Math.max(...values),
    warned: live.filter(r => {
      const result = r.results[field.check];
      return result && !result.pass && !result.na;
    }).length,
    outside: outside.map(p => p.run),
    dead: runs.length - live.length,
    trend: steps,
  };
};

export const readBenchRowResults = (row: BenchRow): RunResults => {
  const at = Object.values(row.results)[0]?.at ?? '';
  return {
    key: row.run,
    at,
    ...(row.infra && { dead: row.infra }),
    axes: {
      point: ['harness', 'model', 'arm', 'engine', 'graph', 'set'].map(k => `${k}=${row.labels[k] ?? ''}`).join(', '),
      case: row.case,
      ...(row.skipped && { hiddenTests: `skipped: ${row.skipped}` }),
      ...row.labels,
    },
    results: row.results,
  };
};
