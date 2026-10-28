import { Schema } from 'effect';

type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isJson = (value: unknown, parents = new Set<unknown>(), depth = 0): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || parents.has(value)) return false;
  if (!Array.isArray(value) && ![Object.prototype, null].includes(Object.getPrototypeOf(value))) return false;
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return false;
  const descriptors = Object.values(Object.getOwnPropertyDescriptors(value));
  if (descriptors.some(d => !('value' in d))) return false;
  const next = new Set(parents).add(value);
  return (Array.isArray(value) ? [...value] : Object.values(value)).every(v => isJson(v, next, depth + 1));
};

const Json = Schema.declare<JsonValue>(isJson);
const Origin = Schema.Struct({
  plugin: Schema.String,
  version: Schema.String,
  job: Schema.String,
  input: Json,
});
const EngineMeta = Schema.Struct({
  origin: Schema.optional(Origin),
  continued: Schema.optional(Schema.Struct({ ...Origin.fields, at: Schema.String })),
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

export const RunMeta = Json.pipe(
  Schema.filter(value =>
    value !== null &&
    typeof value === 'object' &&
    !Array.isArray(value) &&
    Object.keys(value).every(key => /^[a-z][a-z0-9_]*$/i.test(key))
      ? true
      : 'metadata needs owner names'
  ),
  Schema.compose(
    Schema.Record({
      key: Schema.String.pipe(Schema.pattern(/^[a-z][a-z0-9_]*$/i)),
      value: Json,
    })
  )
).pipe(
  Schema.filter(meta =>
    bytes(meta) <= 32_768 && Object.values(meta).every(value => bytes(value) <= 8_192)
      ? true
      : 'metadata exceeds 8192 bytes per owner or 32768 bytes total'
  ),
  Schema.filter(meta =>
    !Object.hasOwn(meta, 'engine') || Schema.is(EngineMeta, { onExcessProperty: 'error' })(meta.engine)
      ? true
      : 'meta.engine must contain engine origin or continuation data'
  )
);
export type RunMeta = typeof RunMeta.Type;

export const getRunOrigin = (meta: RunMeta | undefined) =>
  meta?.engine === undefined ? undefined : Schema.decodeUnknownSync(EngineMeta)(meta.engine).origin;
