import { Schema, Struct } from 'effect';
import type { Check } from './folder.ts';
import { CheckMode, ResultType } from './result.ts';
import { JsonValue, PluginMetadata } from './meta.ts';

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
  runs: RunResults[],
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
