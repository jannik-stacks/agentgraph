/** A top-level declaration. Lines are 1-based and include the TSDoc block above it. */
export type Decl = { name: string; kind: string; exported: boolean; start: number; end: number; doc?: string };

/** Lines strictly between `#region <name>` and `#endregion`. */
export type Region = { name: string; start: number; end: number };

/** One field of an object type. `full` is the expanded type when `type` is a name like `Harness`. */
export type Field = { name: string; type: string; full?: string; required: boolean; default?: string; doc?: string };

/** What the docs know about one source file without its text. */
export type FileMeta = {
  path: string;
  lines: number;
  decls: Decl[];
  regions: Region[];
  tables: Record<string, Field[]>;
};

export type Files = Record<string, FileMeta>;

export type Target = { file?: string | undefined; symbol?: string | undefined; region?: string | undefined };
export type Resolved = { file: FileMeta; name: string; start: number; end: number; doc?: string | undefined };

/** One docs reference, resolved and rendered ahead of time. `html` is the highlighted lines of a `<Source>`. */
export type Ref =
  | { path: string; name: string; start: number; end: number; summary?: string; html?: string; fields?: Field[] }
  | { error: string };

export type Tag = 'Source' | 'Sym' | 'Fields';

/** The key a reference is stored under, the same in the plugin and in the components. */
export const refKey = (tag: Tag, t: Target) => [tag, t.file ?? '', t.symbol ?? '', t.region ?? ''].join('|');

const where = (t: Target) => (t.file ? ` in ${t.file}` : '');

/** Merges declarations of one name that sit next to each other, like a zod schema and its inferred type. */
const span = (decls: Decl[]): Decl => {
  const [first, ...rest] = decls as [Decl, ...Decl[]];
  let end = first.end;
  for (const d of rest) if (d.start <= end + 1) end = Math.max(end, d.end);
  return { ...first, end };
};

/**
 * Finds a symbol, a region, or with only `file` the whole file. Without `file`, the name must be exported by exactly
 * one file.
 */
export const resolve = (files: Files, t: Target): Resolved | { error: string } => {
  const name = t.symbol ?? t.region;
  if (t.file && !files[t.file]) return { error: `no source file ${t.file}` };
  if (!name && t.file) return { file: files[t.file]!, name: t.file, start: 1, end: files[t.file]!.lines };
  if (!name || (t.symbol && t.region)) return { error: 'name exactly one of symbol or region' };
  const candidates = t.file ? [files[t.file]!] : Object.values(files);
  if (t.region) {
    const hits = candidates.flatMap(f => f.regions.filter(r => r.name === t.region).map(r => ({ f, r })));
    if (hits.length !== 1)
      return { error: hits.length ? `region ${name} is in several files, add file=` : `no region ${name}${where(t)}` };
    const { f, r } = hits[0]!;
    return { file: f, name, start: r.start, end: r.end };
  }
  const hits = candidates
    .map(f => ({ f, decls: f.decls.filter(d => d.name === name && (t.file || d.exported)) }))
    .filter(h => h.decls.length);
  if (hits.length !== 1)
    return { error: hits.length ? `${name} is exported by several files, add file=` : `no symbol ${name}${where(t)}` };
  const { f, decls } = hits[0]!;
  const d = span(decls);
  return { file: f, name, start: d.start, end: d.end, doc: decls.find(x => x.doc)?.doc };
};

/** The first sentence of a doc comment. */
export const summary = (doc: string | undefined) => doc?.split(/(?<=\.)\s|\n\n/)[0];
