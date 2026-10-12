import { Document, isMap, isScalar, isSeq, type Node, parse, parseDocument, visit } from 'yaml';
import { z } from 'zod';
import { compile, hubFile, type Config, type ConfigError, type SourceFile } from './config.ts';
import { parseMarkdown } from './markdown.ts';
import { Bot, Check, Hub, IssueFile, Note, NoteKind, Skill, Workflow } from './schema.ts';

/** Every kind of file a hub holds, with its schema and what its Markdown body is. */
export const itemKinds = {
  hub: { schema: Hub, dir: '', body: undefined },
  bot: { schema: Bot, dir: 'bots', body: 'role' },
  skill: { schema: Skill, dir: 'skills', body: 'prompt' },
  check: { schema: Check, dir: 'checks', body: 'extra prompt' },
  workflow: { schema: Workflow, dir: 'workflows', body: 'description' },
  note: { schema: Note, dir: 'notes', body: 'note' },
  issue: { schema: IssueFile, dir: 'issues', body: 'issue and comments' },
} as const;
export type ItemKind = keyof typeof itemKinds;

const named = '[a-z][a-z0-9-]*';
const paths: [ItemKind, RegExp][] = [
  ['hub', /^hub\.yaml$/],
  ['bot', new RegExp(`^bots/(${named})\\.md$`)],
  ['skill', new RegExp(`^skills/(${named})\\.md$`)],
  ['check', new RegExp(`^checks/(${named})\\.md$`)],
  ['workflow', new RegExp(`^workflows/(${named})\\.md$`)],
  ['note', new RegExp(`^notes/(?:${NoteKind.options.join('|')})/([a-z0-9][a-z0-9-]*)\\.md$`)],
  ['issue', /^issues\/([1-9]\d*-[a-z0-9-]*)\.md$/],
];

/** The kind of item a hub-relative path holds, or `undefined` when the path is not one a hub item may live at. */
export const itemKind = (path: string): ItemKind | undefined => paths.find(([, pattern]) => pattern.test(path))?.[0];

/** The name an item is referenced by: the file stem, or `hub` for `hub.yaml`. */
export const itemName = (path: string) => paths.find(([, p]) => p.test(path))?.[1].exec(path)?.[1] ?? 'hub';

/** The note kind of a `notes/<kind>/<slug>.md` path. */
export const noteKindOf = (path: string) => NoteKind.safeParse(path.split('/')[1]).data;

/** Where an item of `kind` named `name` lives. `note` is the note kind for notes. */
export const itemPath = (kind: ItemKind, name: string, note: NoteKind = 'decision') =>
  kind === 'hub' ? hubFile : kind === 'note' ? `notes/${note}/${name}.md` : `${itemKinds[kind].dir}/${name}.md`;

export type JsonSchema = {
  type?: string | string[];
  properties?: Record<string, JsonSchema>;
  required?: string[];
  additionalProperties?: JsonSchema | boolean;
  propertyNames?: JsonSchema;
  items?: JsonSchema;
  anyOf?: JsonSchema[];
  oneOf?: JsonSchema[];
  enum?: unknown[];
  const?: unknown;
  default?: unknown;
  pattern?: string;
  minLength?: number;
  minItems?: number;
  minimum?: number;
  maximum?: number;
  exclusiveMinimum?: number;
  description?: string;
};

const jsonSchemas = new Map<ItemKind, JsonSchema>();

/** The JSON Schema of a kind's frontmatter, as it is written (before defaults and transforms). */
export const itemSchema = (kind: ItemKind): JsonSchema => {
  let schema = jsonSchemas.get(kind);
  if (!schema) {
    schema = z.toJSONSchema(itemKinds[kind].schema, { io: 'input', unrepresentable: 'any' }) as JsonSchema;
    jsonSchemas.set(kind, schema);
  }
  return schema;
};

export type HubItem = { data: Record<string, unknown>; body: string };

const isRecord = (value: unknown): value is Record<string, unknown> =>
  typeof value === 'object' && value !== null && !Array.isArray(value);

/**
 * Parses a hub file into its frontmatter and body. `hub.yaml` has no body.
 * @throws when the YAML does not parse or a Markdown file has no frontmatter.
 */
export const parseItem = (path: string, source: string): HubItem => {
  if (path === hubFile) {
    const data = parse(source) ?? {};
    if (!isRecord(data)) throw new Error('hub.yaml must be a mapping');
    return { data, body: '' };
  }
  const { data, body } = parseMarkdown(source);
  return { data: isRecord(data) ? data : {}, body };
};

export const deepEqual = (a: unknown, b: unknown): boolean => {
  if (a === b) return true;
  if (Array.isArray(a)) return Array.isArray(b) && a.length === b.length && a.every((x, i) => deepEqual(x, b[i]));
  if (!isRecord(a) || !isRecord(b)) return false;
  const keys = Object.keys(a).filter(k => a[k] !== undefined);
  return (
    keys.length === Object.keys(b).filter(k => b[k] !== undefined).length && keys.every(k => deepEqual(a[k], b[k]))
  );
};

const variant = (schema: JsonSchema | undefined, value: unknown): JsonSchema | undefined => {
  const options = schema?.anyOf ?? schema?.oneOf;
  if (!options) return schema;
  const object = isRecord(value);
  return options.find(o => (object ? o.type === 'object' : Array.isArray(value) ? o.type === 'array' : true));
};

/** Drops `undefined`, then orders object keys as the schema declares them, unknown keys last in their own order. */
export const orderKeys = (schema: JsonSchema | undefined, value: unknown): unknown => {
  const s = variant(schema, value);
  if (Array.isArray(value)) return value.map(item => orderKeys(s?.items, item));
  if (!isRecord(value)) return value;
  const props = s?.properties ?? {};
  const rest = typeof s?.additionalProperties === 'object' ? s.additionalProperties : undefined;
  const keys = [...Object.keys(props).filter(k => k in value), ...Object.keys(value).filter(k => !(k in props))];
  return Object.fromEntries(
    keys.filter(k => value[k] !== undefined).map(k => [k, orderKeys(props[k] ?? rest, value[k])])
  );
};

const flowWidth = 72;
const toStringOptions = { lineWidth: 0, flowCollectionPadding: false, nullStr: '' } as const;

/** Short scalar lists and maps of scalars below the top level go on one line. */
const styleNode = (node: unknown, nested: boolean) =>
  visit(node as Node, {
    Seq: (_, seq) => {
      const width = seq.items.reduce((n: number, item) => n + String(isScalar(item) ? item.value : '').length + 2, 0);
      if (seq.items.every(isScalar) && width <= flowWidth) seq.flow = true;
    },
    Map: (_, map, path) => {
      if ((nested || path.length > 0) && map.items.length && map.items.every(pair => isScalar(pair.value)))
        map.flow = true;
    },
  });

/** Frontmatter YAML: keys in schema order, short scalar lists and nested scalar maps on one line. */
export const stringifyData = (kind: ItemKind, data: Record<string, unknown>) => {
  const doc = new Document(orderKeys(itemSchema(kind), data));
  styleNode(doc.contents, false);
  return doc.toString(toStringOptions);
};

const childSchema = (schema: JsonSchema | undefined, value: unknown, key: string) => {
  const s = variant(schema, value);
  return s?.properties?.[key] ?? (typeof s?.additionalProperties === 'object' ? s.additionalProperties : undefined);
};

/**
 * Edits a parsed YAML node from `before` to `after` in place where it can, so unchanged keys keep their position,
 * style and comments. New keys go where the schema order puts them among the keys already there.
 */
const patchNode = (
  doc: Document,
  node: unknown,
  before: unknown,
  after: unknown,
  schema: JsonSchema | undefined
): unknown => {
  if (deepEqual(before, after)) return node;
  if (isMap(node) && isRecord(before) && isRecord(after)) {
    for (const key of Object.keys(before)) if (after[key] === undefined) node.delete(key);
    const order = Object.keys(orderKeys(schema, after) as Record<string, unknown>);
    for (const key of order) {
      const value = after[key];
      const sub = childSchema(schema, after, key);
      if (before[key] !== undefined && node.has(key)) {
        const child = node.get(key, true);
        const next = patchNode(doc, child, before[key], value, sub);
        if (next !== child) node.set(key, next);
        continue;
      }
      const created = doc.createNode(orderKeys(sub, value));
      styleNode(created, true);
      const pair = doc.createPair(key, created);
      const earlier = new Set(order.slice(0, order.indexOf(key)));
      const index = node.items.findLastIndex(p => isScalar(p.key) && earlier.has(String(p.key.value))) + 1;
      node.items.splice(index, 0, pair);
    }
    return node;
  }
  const created = doc.createNode(orderKeys(schema, after)) as Node;
  if (isSeq(node) && isSeq(created) && created.items.every(isScalar)) created.flow = node.flow ?? false;
  else styleNode(created, true);
  return created;
};

const frontmatter = /^---\r?\n([\s\S]*?)\r?\n?---\r?\n?/;

const withBody = (front: string, body: string, gap = '\n') => (body.trim() ? `${front}${gap}${body.trim()}\n` : front);

/** The original YAML with only what changed edited, or `undefined` when it cannot be patched. */
const patchYaml = (kind: ItemKind, yaml: string, before: Record<string, unknown>, after: Record<string, unknown>) => {
  const doc = parseDocument(yaml);
  if (doc.errors.length || !isMap(doc.contents)) return;
  patchNode(doc, doc.contents, before, after, itemSchema(kind));
  const padded = (yaml.match(/[[{] \S/g) ?? []).length > (yaml.match(/[[{][^\s\]}]/g) ?? []).length;
  return doc.toString({ ...toStringOptions, flowCollectionPadding: padded });
};

/**
 * Serialises an item to its file. Deterministic: the same data, body and original always give the same text.
 * Against an `original`, only the changed frontmatter values are rewritten; comments, key order and styles of
 * everything else are kept, and an unchanged frontmatter is kept as written.
 */
export const renderItem = (path: string, { data, body }: HubItem, original?: string): string => {
  const kind = itemKind(path);
  if (!kind) throw new Error(`${path} is not a hub item path`);
  if (original !== undefined) {
    try {
      const before = parseItem(path, original);
      if (kind === 'hub')
        return deepEqual(before.data, data)
          ? original
          : (patchYaml(kind, original, before.data, data) ?? stringifyData(kind, data));
      const match = frontmatter.exec(original);
      if (match) {
        if (deepEqual(before.data, data) && before.body === body.trim()) return original;
        const yaml = deepEqual(before.data, data)
          ? `${match[1]}\n`
          : patchYaml(kind, match[1] ?? '', before.data, data);
        const rest = original.slice(match[0].length);
        const gap = rest.trim() ? /^\s*/.exec(rest)?.[0] : undefined;
        if (yaml !== undefined) return withBody(`---\n${yaml.trim() ? yaml : ''}---\n`, body, gap);
      }
    } catch {}
  }
  const yaml = stringifyData(kind, data);
  if (kind === 'hub') return yaml;
  return withBody(`---\n${Object.keys(data).length ? yaml : ''}---\n`, body);
};

/** A pending edit to one hub file: its new frontmatter and body, or its deletion. */
export type Change = { path: string } & ({ data: Record<string, unknown>; body?: string } | { delete: true });

/** Applies changes to a hub's files, rendering each changed file against its current text. */
export const applyChanges = (files: SourceFile[], changes: Change[]): SourceFile[] => {
  const byPath = new Map(files.map(f => [f.path, f.source]));
  for (const change of changes) {
    if ('delete' in change) byPath.delete(change.path);
    else
      byPath.set(
        change.path,
        renderItem(change.path, { data: change.data, body: change.body ?? '' }, byPath.get(change.path))
      );
  }
  return [...byPath].map(([path, source]) => ({ path, source })).sort((a, b) => a.path.localeCompare(b.path));
};

export type FieldIssue = { path: (string | number)[]; message: string };

/** Schema problems in one item's frontmatter, each at the field path it is about. */
export const fieldIssues = (path: string, data: Record<string, unknown>): FieldIssue[] => {
  const kind = itemKind(path);
  if (!kind) return [{ path: [], message: 'not a hub item path' }];
  const parsed = itemKinds[kind].schema.safeParse(data);
  return parsed.success
    ? []
    : parsed.error.issues.map(issue => ({
        path: issue.path.map(p => (typeof p === 'symbol' ? String(p) : p)),
        message: issue.message,
      }));
};

export type HubValidation = { ok: boolean; errors: ConfigError[]; warnings: ConfigError[]; config?: Config };

/** Validates a whole hub as it would be on disk: the compiled config and every local issue file. */
export const validateHub = (files: SourceFile[]): HubValidation => {
  const errors: ConfigError[] = [];
  const numbers = new Map<string, string>();
  for (const file of files) {
    if (!file.path.startsWith('issues/')) continue;
    if (itemKind(file.path) !== 'issue') {
      errors.push({ path: file.path, message: 'issue files are named <number>-<slug>.md' });
      continue;
    }
    const number = itemName(file.path).split('-')[0] ?? '';
    const other = numbers.get(number);
    if (other) errors.push({ path: file.path, message: `has the same number as ${other}` });
    numbers.set(number, file.path);
    try {
      const parsed = IssueFile.safeParse(parseItem(file.path, file.source).data);
      if (!parsed.success) errors.push({ path: file.path, message: z.prettifyError(parsed.error) });
    } catch (e) {
      errors.push({ path: file.path, message: (e as Error).message });
    }
  }
  const compiled = compile(files.filter(f => !f.path.startsWith('issues/')));
  if (!compiled.ok) errors.push(...compiled.errors);
  return compiled.ok && !errors.length
    ? { ok: true, errors, warnings: compiled.warnings, config: compiled.config }
    : { ok: false, errors, warnings: compiled.ok ? compiled.warnings : [] };
};

const referenceKeys: Partial<Record<ItemKind, string[]>> = {
  bot: ['bot', 'subagents'],
  skill: ['skill', 'skills'],
  check: ['check', 'checks'],
};

const replaceRefs = (value: unknown, keys: string[], from: string, to: string, inKey = false): unknown => {
  if (Array.isArray(value)) return value.map(item => replaceRefs(item, keys, from, to, inKey));
  if (isRecord(value))
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceRefs(v, keys, from, to, keys.includes(k))])
    );
  return inKey && value === from ? to : value;
};

/** The edits that point every reference to the `kind` item `from` at `to` instead. */
export const renameReferences = (files: SourceFile[], kind: ItemKind, from: string, to: string): Change[] => {
  const keys = referenceKeys[kind];
  if (!keys) return [];
  const changes: Change[] = [];
  for (const file of files) {
    const k = itemKind(file.path);
    if (k !== 'bot' && k !== 'check' && k !== 'workflow' && k !== 'note') continue;
    try {
      const item = parseItem(file.path, file.source);
      const data = replaceRefs(item.data, keys, from, to) as Record<string, unknown>;
      if (!deepEqual(data, item.data)) changes.push({ path: file.path, data, body: item.body });
    } catch {}
  }
  return changes;
};

/** A starting value for a schema: defaults, the first enum option, and only the required properties. */
export const initialValue = (schema: JsonSchema): unknown => {
  if (schema.default !== undefined) return structuredClone(schema.default);
  if (schema.const !== undefined) return schema.const;
  if (schema.enum) return schema.enum[0];
  const options = schema.anyOf ?? schema.oneOf;
  if (options?.[0]) return initialValue(options.find(o => o.type !== 'null') ?? options[0]);
  const type = Array.isArray(schema.type) ? schema.type[0] : schema.type;
  if (type === 'object')
    return Object.fromEntries((schema.required ?? []).map(k => [k, initialValue(schema.properties?.[k] ?? {})]));
  if (type === 'array') return [];
  if (type === 'string') return '';
  if (type === 'boolean') return false;
  if (type === 'number' || type === 'integer') return schema.exclusiveMinimum !== undefined ? 1 : (schema.minimum ?? 0);
  return null;
};
