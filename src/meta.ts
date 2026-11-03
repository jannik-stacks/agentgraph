import { Option, Schema } from 'effect';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };

const isJson = (value: unknown, parents = new Set<unknown>(), depth = 0): value is JsonValue => {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || depth > 32 || parents.has(value)) return false;
  if (
    Array.isArray(value)
      ? Object.getPrototypeOf(value) !== Array.prototype
      : ![Object.prototype, null].includes(Object.getPrototypeOf(value))
  )
    return false;
  const descriptors = Object.getOwnPropertyDescriptors(value);
  if (Reflect.ownKeys(value).some(key => typeof key === 'symbol')) return false;
  if (
    Array.isArray(value) &&
    (Object.keys(descriptors).length !== value.length + 1 ||
      Object.keys(descriptors).some(
        key => key !== 'length' && (String(Number(key)) !== key || Number(key) >= value.length)
      ))
  )
    return false;
  const next = new Set(parents).add(value);
  return Object.entries(descriptors).every(([key, descriptor]) =>
    Array.isArray(value) && key === 'length'
      ? true
      : descriptor.enumerable && 'value' in descriptor && isJson(descriptor.value, next, depth + 1)
  );
};

export const JsonValue = Schema.declare<JsonValue>(isJson);
const Origin = Schema.Struct({
  plugin: Schema.String,
  version: Schema.String,
  job: Schema.String,
  input: JsonValue,
});
const EngineMetadata = Schema.Struct({
  origin: Schema.optionalKey(Origin),
  continued: Schema.optionalKey(Schema.Struct({ ...Origin.fields, at: Schema.String })),
});
const bytes = (value: unknown) => new TextEncoder().encode(JSON.stringify(value)).length;

const Owner = Schema.String.check(Schema.isPattern(/^[a-z][a-z0-9_]*$/i));

export const PluginMetadata = JsonValue.check(
  Schema.makeFilter(value =>
    value !== null && typeof value === 'object' && !Array.isArray(value) && Object.keys(value).every(Schema.is(Owner))
      ? true
      : 'metadata needs owner names'
  )
).pipe(
  Schema.decodeTo(
    Schema.Record(Owner, JsonValue).check(
      Schema.makeFilter(meta =>
        bytes(meta) <= 32_768 && Object.values(meta).every(value => bytes(value) <= 8_192)
          ? true
          : 'metadata exceeds 8192 bytes per owner or 32768 bytes total'
      ),
      Schema.makeFilter(meta =>
        !Object.hasOwn(meta, 'engine') ||
        Option.isSome(Schema.decodeUnknownOption(EngineMetadata, { onExcessProperty: 'error' })(meta.engine))
          ? true
          : 'meta.engine must contain engine origin or continuation data'
      )
    )
  )
);
export type PluginMetadata = typeof PluginMetadata.Type;

export const getRunOrigin = (meta: PluginMetadata | undefined) => {
  const origin = meta?.engine === undefined ? undefined : Schema.decodeUnknownSync(EngineMetadata)(meta.engine).origin;
  if (origin === undefined) return;
  const json = JSON.stringify(origin);
  return Schema.decodeUnknownSync(Origin)(JSON.parse(json));
};

export const makeContinuedMeta = (
  before: PluginMetadata | undefined,
  input: PluginMetadata,
  at: string
): PluginMetadata => {
  const engine = before?.engine === undefined ? {} : Schema.decodeUnknownSync(EngineMetadata)(before.engine);
  const origin = getRunOrigin(input);
  return { ...before, ...input, engine: { ...engine, ...(origin && { continued: { ...origin, at } }) } };
};
