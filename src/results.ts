import { Schema, Struct } from 'effect';
import { CheckMode, ResultType } from './result.ts';
import { JsonValue, PluginMetadata } from './meta.ts';
import type { Event } from './event.ts';

import { isWaitingOnPeople, type Check, type Run, type RunRecord, type Trace } from './types.ts';

const Field = Schema.Struct({
  check: Schema.String,
  field: Schema.String,
  mode: Schema.optionalKey(CheckMode),
  limit: Schema.optionalKey(ResultType.mapFields(Struct.pick(['minimum', 'maximum']))),
  ...Struct.pick(ResultType.fields, ['type', 'description', 'unit']),
});
const ResultValue = Schema.Record(Schema.String, Schema.Unknown).check(
  Schema.makeFilter(value => Schema.is(JsonValue)(value))
);
const Measurement = Schema.Struct({
  at: Schema.String,
  pass: Schema.Boolean,
  value: Schema.optionalKey(ResultValue),
  share: Schema.optionalKey(Schema.Finite),
  empty: Schema.optionalKey(Schema.Literal(true)),
  na: Schema.optionalKey(Schema.Literal(true)),
  later: Schema.optionalKey(Schema.Literal(true)),
  older: Schema.optionalKey(Schema.Literal(true)),
});
const Row = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  href: Schema.optionalKey(Schema.String.check(Schema.isPattern(/^\/(?!\/)(?!.*[\s\\])/s))),
  dead: Schema.optionalKey(Schema.String),
  axes: Schema.Record(Schema.String, Schema.String),
  results: Schema.Record(Schema.String, Measurement),
  meta: Schema.optionalKey(PluginMetadata),
});

export const ResultSheet = Schema.Struct({
  fields: Schema.mutable(Schema.Array(Field)),
  runs: Schema.mutable(Schema.Array(Row)),
});

type CheckField = typeof Field.Type;
type RunResults = typeof Row.Type;
const isScalar = (value: unknown): value is number | boolean | string =>
  typeof value === 'number' || typeof value === 'boolean' || typeof value === 'string';

export const findCheckFields = (
  runs: readonly Pick<RunResults, 'results'>[],
  checks: Record<string, Pick<Check, 'mode' | 'returns' | 'pass'>> = {}
): CheckField[] => {
  const seen = new Map<string, CheckField>();
  for (const run of runs)
    for (const [check, r] of Object.entries(run.results)) {
      const values = { ...r.value, ...(r.share !== undefined && { share: r.share }) };
      for (const [field, v] of Object.entries(values)) {
        const key = `${check} ${field}`;
        if (seen.has(key) || !isScalar(v)) continue;
        const c = checks[check];
        const t = c?.returns?.properties?.[field];
        const limit = Struct.pick(c?.pass?.properties?.[field] ?? {}, ['minimum', 'maximum']);
        seen.set(key, {
          check,
          field,
          ...(c && { mode: c.mode }),
          ...Struct.pick(t ?? {}, ['description', 'unit']),
          type: t?.type ?? (typeof v === 'number' ? 'number' : typeof v === 'boolean' ? 'boolean' : 'string'),
          ...(field === 'share' && !t?.unit && { unit: 'share' }),
          ...(Object.keys(limit).length > 0 && { limit }),
        });
      }
    }
  return [...seen.values()];
};

export const mergeCheckFields = (lists: readonly CheckField[][]) => {
  const seen = new Map<string, CheckField>();
  const conflicts = new Set<string>();
  for (const f of lists.flat()) {
    const key = `${f.check} ${f.field}`;
    const was = seen.get(key);
    if (!was) seen.set(key, f);
    else if (was.type !== f.type || was.unit !== f.unit) conflicts.add(key);
  }
  return {
    fields: [...seen].flatMap(([key, f]) => (conflicts.has(key) ? [] : [f])),
    conflicts: [...conflicts].map(key => `${key.replace(' ', ' field ')} has different types or units across configs`),
  };
};

const findInputCoverage = (run: Pick<RunRecord, 'started'>, trace: readonly Trace[]) => {
  const since = trace.flatMap(t => ('inputs' in t ? [t.inputs.since] : []))[0];
  return since === undefined ? 'missing' : since > run.started ? 'partial' : 'complete';
};

const sumWaitMs = (run: Pick<RunRecord, 'ended'>, trace: readonly Trace[], now: string) => {
  const state: Partial<Run> = {};
  let from: string | undefined;
  let waited = 0;
  for (const t of trace) {
    if (!('saved' in t)) continue;
    Object.assign(state, t.saved);
    for (const key of t.cleared ?? []) delete state[key];
    if (isWaitingOnPeople(state)) from ??= t.at;
    else if (from !== undefined) {
      waited += Date.parse(t.at) - Date.parse(from);
      from = undefined;
    }
  }
  const tail = from === undefined ? 0 : Math.max(0, Date.parse(run.ended ?? now) - Date.parse(from));
  return { waited: waited + tail, open: run.ended === undefined ? tail : 0 };
};

export const sumHumanInteractions = (
  runs: readonly { run: Pick<RunRecord, 'started' | 'ended'>; trace: readonly Trace[] }[],
  now: string
) => {
  const people = new Map<string, Event>();
  for (const { run, trace } of runs)
    for (const t of trace)
      if ('spoken' in t && !t.spoken.bot && t.spoken.at >= run.started && t.spoken.at <= (run.ended ?? now))
        people.set(`${t.spoken.issue}#${t.spoken.id}`, t.spoken);
  const count = (is: (m: Event) => boolean) => [...people.values()].filter(is).length;
  const waits = runs.map(({ run, trace }) => sumWaitMs(run, trace, now));
  const coverages = new Set(runs.map(({ run, trace }) => findInputCoverage(run, trace)));
  return {
    coverage: (['missing', 'partial'] as const).find(c => coverages.has(c)) ?? 'complete',
    comments: count(m => m.kind === 'comment' && !m.review),
    reviews: count(m => m.kind === 'approved' || m.kind === 'changes_requested' || !!m.review),
    labels: count(m => m.kind === 'label' || m.kind === 'unlabel'),
    requests: count(m => m.kind === 'review_requested'),
    waitSeconds: Math.round(waits.reduce((a, w) => a + w.waited, 0) / 1000),
    openWaitSeconds: Math.round(waits.reduce((a, w) => a + w.open, 0) / 1000),
  };
};
