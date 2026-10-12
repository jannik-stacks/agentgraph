/** A top-level declaration. Lines are 1-based and include the TSDoc block above it. */
export type Decl = { name: string; kind: string; exported: boolean; start: number; end: number; doc?: string };

/** Lines strictly between `#region <name>` and `#endregion`. */
export type Region = { name: string; start: number; end: number };

/** One field of an object type. `full` is the expanded type when `type` is a name like `Harness`. */
export type Field = { name: string; type: string; full?: string; required: boolean; default?: string; doc?: string };

/** What the docs know about one source file without its text. */
export type FileMeta = {
  path: string;
  lang: string;
  lineCount: number;
  doc?: string;
  decls: Decl[];
  regions: Region[];
  tables: Record<string, Field[]>;
};

/** Highlighted lines as `[text, style index]` tokens, with the style palette they index into. */
export type FileText = { path: string; styles: Record<string, string>[]; lines: [string, number][][] };

export type Files = Record<string, FileMeta>;

export type Target = { file?: string | undefined; symbol?: string | undefined; region?: string | undefined };
export type Resolved = { file: FileMeta; name: string; start: number; end: number; doc?: string | undefined };

const where = (t: Target) => (t.file ? ` in ${t.file}` : '');

/** Merges declarations of one name that sit next to each other, like a zod schema and its inferred type. */
const span = (decls: Decl[]): Decl => {
  const [first, ...rest] = decls as [Decl, ...Decl[]];
  let end = first.end;
  for (const d of rest) if (d.start <= end + 1) end = Math.max(end, d.end);
  return { ...first, end };
};

/** Finds a symbol or region. Without `file`, the name must be exported by exactly one file. */
export const resolve = (files: Files, t: Target): Resolved | { error: string } => {
  const name = t.symbol ?? t.region;
  if (!name || (t.symbol && t.region)) return { error: 'name exactly one of symbol or region' };
  if (t.file && !files[t.file]) return { error: `no source file ${t.file}` };
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

export const lineHash = (start: number, end: number) => (start === end ? `#L${start}` : `#L${start}-L${end}`);
export const sourceHref = (path: string, start?: number, end?: number) =>
  `/source/${path}${start ? lineHash(start, end ?? start) : ''}`;

/** The first sentence of a doc comment. */
export const summary = (doc: string | undefined) => doc?.split(/(?<=\.)\s|\n\n/)[0];
