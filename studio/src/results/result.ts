import type { readBenchRows } from '../../../bin/bench.ts';
import type { Check } from '../../../src/folder.ts';
import type { ResultType } from '../../../src/result.ts';
import type { CheckResult } from '../../../src/workflow.ts';
import { formatNumber } from '../runs/trace.ts';

export const resultSources = ['runs', 'bench', 'tune'] as const;
export type ResultSource = (typeof resultSources)[number];

export type CheckField = { check: string; field: string; mode?: Check['mode'] } & Pick<
  ResultType,
  'type' | 'description' | 'unit'
> & { limit?: Pick<ResultType, 'minimum' | 'maximum'> };

export type RunResult = Pick<CheckResult, 'pass' | 'value' | 'share' | 'empty'> & {
  at: string;
  later?: true;
  older?: true;
};

export type RunResults = {
  key: string;
  at: string;
  href?: string;
  dead?: string;
  axes: Record<string, string>;
  results: Record<string, RunResult>;
};

const scalar = (v: unknown): v is number | boolean | string =>
  typeof v === 'number' || typeof v === 'boolean' || typeof v === 'string';

export const readFieldValue = (run: RunResults, f: Pick<CheckField, 'check' | 'field'>) => {
  const r = run.results[f.check];
  if (!r || r.empty) return undefined;
  const v = f.field === 'share' && r.value?.share === undefined ? r.share : r.value?.[f.field];
  return typeof v === 'boolean' ? +v : v;
};

export const findCheckFields = (
  runs: RunResults[],
  checks: Record<string, Pick<Check, 'mode' | 'returns' | 'pass'>> = {}
): CheckField[] => {
  const seen = new Map<string, CheckField>();
  for (const run of runs)
    for (const [check, r] of Object.entries(run.results)) {
      const values = { ...r.value, ...(r.share !== undefined && { share: r.share }) };
      for (const [field, v] of Object.entries(values)) {
        const key = `${check} ${field}`;
        if (seen.has(key) || !scalar(v)) continue;
        const c = checks[check];
        const t = c?.returns?.properties?.[field];
        const limit = c?.pass?.properties?.[field];
        seen.set(key, {
          check,
          field,
          ...(c && { mode: c.mode }),
          type: t?.type ?? (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string'),
          ...(t?.description && { description: t.description }),
          ...((t?.unit ?? (field === 'share' ? 'share' : undefined)) && { unit: t?.unit ?? 'share' }),
          ...(limit &&
            (limit.minimum !== undefined || limit.maximum !== undefined) && {
              limit: {
                ...(limit.minimum !== undefined && { minimum: limit.minimum }),
                ...(limit.maximum !== undefined && { maximum: limit.maximum }),
              },
            }),
        });
      }
    }
  return [...seen.values()];
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

const getMedian = (xs: number[]) => {
  const sorted = xs.toSorted((a, b) => a - b);
  const mid = sorted.length >> 1;
  return sorted.length % 2 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2;
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
  ].map(group => getMedian(group.map(run => readFieldValue(run, field) as number)));
  return {
    points,
    values,
    median: values.length ? getMedian(values) : undefined,
    low: Math.min(...values),
    high: Math.max(...values),
    warned: live.filter(r => r.results[field.check] && !r.results[field.check]!.pass).length,
    outside: outside.map(p => p.run),
    dead: runs.length - live.length,
    trend: steps,
  };
};

type BenchRow = ReturnType<typeof readBenchRows>[number];

export const benchFields: CheckField[] = [
  {
    check: 'bench',
    field: 'hidden',
    type: 'number',
    unit: 'share',
    description: 'share of the hidden tests that pass',
  },
  { check: 'bench', field: 'usd', type: 'number', unit: 'usd', description: 'list price of the arm’s sessions' },
  { check: 'bench', field: 'checkUsd', type: 'number', unit: 'usd', description: 'list price of judging its checks' },
  { check: 'bench', field: 'minutes', type: 'number', unit: 'minutes', description: 'wall time of the arm' },
];

export const readBenchRowResults = (row: BenchRow, at = ''): RunResults => {
  const [, harness = '', model = '', arm = '', engine = '', graph = '', set = ''] =
    /^([^:]*):([^/]*)\/([^@]*)@([^/]*)\/([^/]*)\/(.*)$/.exec(row.point) ?? [];
  const hidden = row.hiddenShare ?? row.hidden;
  return {
    key: `${row.point} ${row.case} ${row.repeat}`,
    at: Object.values(row.checks ?? {})[0]?.at ?? at,
    ...(row.infra && { dead: row.infra }),
    axes: {
      point: `${harness}:${model}/${arm}`,
      harness,
      model,
      arm,
      engine,
      graph,
      set,
      case: row.case,
      ...(row.strata.repo && { repo: row.strata.repo }),
    },
    results: {
      ...row.checks,
      bench: {
        at,
        pass: true,
        value: {
          ...(hidden !== undefined && { hidden }),
          usd: row.usd,
          checkUsd: row.checkUsd,
          minutes: row.minutes,
        },
      },
    },
  };
};
