import { Schema } from 'effect';
import type { Check } from './folder.ts';
import { CheckMode, ResultType } from './result.ts';
import { JsonValue, PluginMetadata } from './meta.ts';

const optional = <S extends Schema.Schema.Any>(schema: S) => Schema.optionalWith(schema, { exact: true });
const Field = Schema.Struct({
  check: Schema.String,
  field: Schema.String,
  mode: optional(CheckMode),
  limit: optional(
    ResultType.pipe(
      Schema.pick('minimum', 'maximum'),
      Schema.filter(value => Object.values(value).every(Number.isFinite))
    )
  ),
}).pipe(Schema.extend(ResultType.pipe(Schema.pick('type', 'description', 'unit'))));
const ResultValue = Schema.Record({ key: Schema.String, value: Schema.Unknown }).pipe(
  Schema.filter((value): boolean => Schema.is(JsonValue)(value))
);
const Measurement = Schema.Struct({
  at: Schema.String,
  pass: Schema.Boolean,
  value: optional(ResultValue),
  share: optional(Schema.JsonNumber),
  empty: optional(Schema.Literal(true)),
  later: optional(Schema.Literal(true)),
  older: optional(Schema.Literal(true)),
});
const Row = Schema.Struct({
  key: Schema.String,
  at: Schema.String,
  href: optional(
    Schema.String.pipe(
      Schema.pattern(/^\/(?!\/)/),
      Schema.filter(value => {
        try {
          return new URL(value, 'http://studio').href === `http://studio${value}`;
        } catch {
          return false;
        }
      })
    )
  ),
  dead: optional(Schema.String),
  axes: Schema.Record({ key: Schema.String, value: Schema.String }),
  results: Schema.Record({ key: Schema.String, value: Measurement }),
  meta: optional(PluginMetadata),
});

export const ResultSheet = Schema.Struct({
  fields: Schema.mutable(Schema.Array(Field).pipe(Schema.maxItems(1000))),
  runs: Schema.mutable(Schema.Array(Row).pipe(Schema.maxItems(10000))),
}).pipe(
  Schema.filter(sheet =>
    new Set(sheet.runs.map(row => row.key)).size === sheet.runs.length &&
    new Set(sheet.fields.map(field => JSON.stringify([field.check, field.field]))).size === sheet.fields.length
      ? true
      : 'result row and field keys must be unique'
  )
);

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
