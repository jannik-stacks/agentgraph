import { readdir, readFile, stat } from 'node:fs/promises';
import { join, relative, resolve as resolvePath, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { createHighlighter, type Highlighter } from 'shiki';
import { parseSync, type Plugin, type ViteDevServer } from 'vite';
import {
  type Decl,
  type Field,
  type FileMeta,
  type Files,
  type Ref,
  refKey,
  type Region,
  resolve,
  summary,
  type Tag,
} from './model.ts';

/** What under the bothub root the docs may show. Anything that looks like a secret is skipped. */
const roots = ['src', 'infra'];
const rootFiles = ['package.json', 'tsconfig.json'];
const secret = /(^|\/)\.|\.env\b|secret|\.pem$|\.key$/i;
const skipDirs = new Set(['node_modules', 'dist', '.git']);

const langs: [RegExp, string][] = [
  [/\.tsx$/, 'tsx'],
  [/\.ts$/, 'typescript'],
  [/\.m?js$/, 'javascript'],
  [/\.jsonc$/, 'jsonc'],
  [/\.json$/, 'json'],
  [/\.ya?ml$/, 'yaml'],
  [/\.sh$/, 'shellscript'],
  [/(^|\/)Dockerfile$/, 'dockerfile'],
  [/\.md$/, 'markdown'],
  [/\.html$/, 'html'],
  [/\.(service|timer|conf|ini)$/, 'ini'],
];
const langOf = (path: string) => langs.find(([re]) => re.test(path))?.[1] ?? 'text';

let highlighter: Promise<Highlighter> | undefined;
const highlight = async (code: string, lang: string) => {
  highlighter ??= createHighlighter({
    themes: ['github-light', 'github-dark'],
    langs: [...new Set(langs.map(([, l]) => l))],
  });
  const h = await highlighter;
  const { tokens } = h.codeToTokens(code, {
    lang: lang as 'text',
    themes: { light: 'github-light', dark: 'github-dark' },
    defaultColor: false,
  });
  const plain = `--shiki-light:${h.getTheme('github-light').fg};--shiki-dark:${h.getTheme('github-dark').fg}`;
  return { tokens, plain: plain.toLowerCase() };
};

type Node = { type: string; start: number; end: number } & Record<string, any>;
type Comment = { type: string; value: string; start: number; end: number };

const lineIndex = (text: string) => {
  const starts = [0];
  for (let i = 0; i < text.length; i++) if (text[i] === '\n') starts.push(i + 1);
  return (offset: number) => {
    let lo = 0;
    let hi = starts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (starts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo + 1;
  };
};

/** The description part of a `/** … *\/` block, without tags. */
const cleanDoc = (value: string) => {
  const lines = value
    .replace(/^\*/, '')
    .split('\n')
    .map(l => l.replace(/^\s*\* ?/, '').trimEnd());
  const tag = lines.findIndex(l => /^@\w/.test(l.trim()));
  const body = (tag < 0 ? lines : lines.slice(0, tag)).join('\n').trim();
  return (
    body
      .split(/\n\s*\n/)
      .map(p => p.replace(/\s*\n\s*/g, ' '))
      .join('\n\n') || undefined
  );
};

const keyName = (key: Node | undefined) =>
  key?.type === 'Identifier' ? (key.name as string) : key?.type === 'Literal' ? String(key.value) : undefined;

const objectFns = new Set(['object', 'strictObject', 'looseObject']);

/** The object literal of a `z.object(…)`-style call at the root of a method chain. */
const zodShape = (init: Node | undefined): Node | undefined => {
  let expr = init;
  while (expr?.type === 'CallExpression') {
    const callee = expr.callee as Node;
    if (callee.type !== 'MemberExpression') return;
    if (callee.object.type === 'Identifier' && callee.object.name === 'z' && objectFns.has(callee.property.name))
      return expr.arguments[0]?.type === 'ObjectExpression' ? expr.arguments[0] : undefined;
    expr = callee.object;
  }
};

const quoteKey = (k: string) => (/^[A-Za-z_$][\w$]*$/.test(k) ? k : JSON.stringify(k));
const wrap = (t: string) => (t.includes(' | ') ? `(${t})` : t);

/** A JSON Schema rendered as a short TypeScript-like type. */
const typeOf = (s: any): string => {
  if (!s || typeof s !== 'object') return 'unknown';
  if ('const' in s) return JSON.stringify(s.const);
  if (s.enum) return s.enum.map((v: unknown) => JSON.stringify(v)).join(' | ');
  const union = s.anyOf ?? s.oneOf;
  if (union) return [...new Set<string>(union.map(typeOf))].join(' | ');
  if (Array.isArray(s.type)) return s.type.map((t: string) => typeOf({ ...s, type: t })).join(' | ');
  switch (s.type) {
    case 'string':
    case 'integer':
    case 'number':
    case 'boolean':
    case 'null':
      return s.type;
    case 'array':
      return `${wrap(typeOf(s.items))}[]`;
    case 'object': {
      if (s.properties) {
        const req = new Set<string>(s.required ?? []);
        const fields = Object.entries(s.properties).map(
          ([k, v]) => `${quoteKey(k)}${req.has(k) ? '' : '?'}: ${typeOf(v)}`
        );
        return `{ ${fields.join('; ')} }`;
      }
      if (s.additionalProperties && typeof s.additionalProperties === 'object')
        return `Record<${s.propertyNames ? typeOf(s.propertyNames) : 'string'}, ${typeOf(s.additionalProperties)}>`;
      return 'object';
    }
  }
  return 'unknown';
};

/** Reads one TypeScript file: declarations, regions, module doc and field tables. */
const analyzeTs = async (abs: string, text: string, version: number) => {
  const { program, comments, errors } = parseSync(abs, text, { lang: abs.endsWith('x') ? 'tsx' : 'ts' });
  if (errors.length) throw new Error(`${abs}: ${errors[0]!.message}`);
  const line = lineIndex(text);
  const docs = (comments as Comment[]).filter(c => c.type === 'Block' && c.value.startsWith('*'));
  const docBefore = (start: number) => {
    const c = docs.findLast(c => c.end <= start);
    return c && /^[\s,;]*$/.test(text.slice(c.end, start)) ? c : undefined;
  };

  const body = program.body as Node[];
  const decls: Decl[] = [];
  const reexported = new Set(
    body
      .flatMap(s => (s.type === 'ExportNamedDeclaration' && !s.declaration && !s.source ? s.specifiers : []))
      .map((s: Node) => s.local.name as string)
  );
  const shapes: { name: string; props: Node[]; zod: boolean }[] = [];
  for (const stmt of body) {
    const exported = stmt.type === 'ExportNamedDeclaration' || stmt.type === 'ExportDefaultDeclaration';
    const decl: Node | undefined = exported ? stmt.declaration : stmt;
    if (!decl) continue;
    const comment = docBefore(stmt.start);
    const doc = comment && cleanDoc(comment.value);
    const start = line(comment?.start ?? stmt.start);
    const end = line(stmt.end - 1);
    const add = (name: string, kind: string) => decls.push({ name, kind, exported, start, end, ...(doc && { doc }) });
    switch (decl.type) {
      case 'VariableDeclaration':
        for (const d of decl.declarations as Node[]) {
          if (d.id.type !== 'Identifier') continue;
          add(d.id.name, decl.kind);
          const shape = zodShape(d.init);
          if (shape) shapes.push({ name: d.id.name, props: shape.properties, zod: true });
        }
        break;
      case 'FunctionDeclaration':
      case 'TSDeclareFunction':
        if (decl.id) add(decl.id.name, 'function');
        else add('default', 'function');
        break;
      case 'ClassDeclaration':
        add(decl.id?.name ?? 'default', 'class');
        break;
      case 'TSEnumDeclaration':
        add(decl.id.name, 'enum');
        break;
      case 'TSTypeAliasDeclaration':
        add(decl.id.name, 'type');
        if (decl.typeAnnotation.type === 'TSTypeLiteral')
          shapes.push({ name: decl.id.name, props: decl.typeAnnotation.members, zod: false });
        break;
      case 'TSInterfaceDeclaration':
        add(decl.id.name, 'interface');
        shapes.push({ name: decl.id.name, props: decl.body.body, zod: false });
        break;
      default:
        if (stmt.type === 'ExportDefaultDeclaration') add('default', 'default');
    }
  }

  for (const d of decls) if (reexported.has(d.name)) d.exported = true;

  let mod: Record<string, any> | undefined;
  if (shapes.some(s => s.zod)) {
    try {
      mod = await import(/* @vite-ignore */ `${pathToFileURL(abs).href}?v=${version}`);
    } catch (e) {
      console.warn(`[bothub-code] could not load ${abs} for zod tables, showing zod source instead: ${e}`);
    }
  }

  const tables: Record<string, Field[]> = {};
  for (const { name, props, zod } of shapes) {
    if (tables[name]) continue;
    let json: any;
    if (zod && typeof mod?.[name]?.toJSONSchema === 'function') {
      try {
        json = mod[name].toJSONSchema({ io: 'input', unrepresentable: 'any' });
      } catch {}
    }
    if (json && !json.properties) json = (json.anyOf ?? json.oneOf)?.find((m: any) => m.properties);
    const required = new Set<string>(json?.required ?? []);
    tables[name] = props.flatMap((p): Field[] => {
      const key = keyName(p.key);
      if (!key) return [];
      const doc = docBefore(p.start);
      const schema = json?.properties?.[key];
      const source = (n: Node | undefined) => (n ? text.slice(n.start, n.end).replace(/\s+/g, ' ') : 'unknown');
      let field: Field;
      if (zod) {
        const code = source(p.value);
        const named = /^(?:z\.array\()?([A-Z]\w*)\)?(?:\.(?:optional|exactOptional|nullish|default)\(.*\))?$/.exec(
          code
        );
        const full = schema ? typeOf(schema) : code;
        const record = /^z\.record\([^,]+,\s*([A-Z]\w*)\)/.exec(code);
        const short = named
          ? `${named[1]}${code.startsWith('z.array(') ? '[]' : ''}`
          : record
            ? `Record<string, ${record[1]}>`
            : full;
        field = {
          name: key,
          type: short,
          required: json ? required.has(key) : !/\.(optional|exactOptional|nullish|default)\(/.test(code),
          ...(short !== full && { full }),
        };
      } else {
        field = {
          name: key,
          type:
            p.type === 'TSPropertySignature' ? source(p.typeAnnotation?.typeAnnotation) : text.slice(p.key.end, p.end),
          required: !p.optional,
        };
      }
      if (schema && 'default' in schema) field.default = JSON.stringify(schema.default);
      const description = doc ? cleanDoc(doc.value) : schema?.description;
      if (description) field.doc = description;
      return [field];
    });
  }
  return { decls, tables };
};

const regionsOf = (text: string): Region[] => {
  const out: Region[] = [];
  const open: { name: string; start: number }[] = [];
  text.split('\n').forEach((l, i) => {
    const start = /^\s*(?:\/\/|#|<!--)\s*#region\s+([\w-]+)/.exec(l);
    if (start) open.push({ name: start[1]!, start: i + 2 });
    else if (/^\s*(?:\/\/|#|<!--)\s*#endregion/.test(l)) {
      const r = open.pop();
      if (r) out.push({ ...r, end: i });
    }
  });
  return out;
};

const escape = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const declarations = (style: Record<string, string> | undefined) =>
  style
    ? Object.entries(style)
        .map(([k, v]) => `${k}:${v}`)
        .join(';')
    : '';

type Entry = { mtime: number; meta: FileMeta; raw: string; lines?: Promise<string[]> };
type Found = { at: string; tag: Tag; target: { file?: string; symbol?: string; region?: string } };

/**
 * Resolves every `<Source>`, `<Sym>` and `<Fields>` in the docs against bothub's own source and serves the results,
 * already highlighted, as `virtual:bothub-code`. A build fails when the docs name a symbol, region or file the source
 * does not have.
 */
export const bothubCode = (options: { root: string; content: string }): Plugin => {
  const root = resolvePath(options.root);
  const content = resolvePath(options.content);
  const cache = new Map<string, Entry>();
  let server: ViteDevServer | undefined;
  let served: string | undefined;
  const palette = new Map<string, number>();
  const classOf = (style: Record<string, string> | undefined) => {
    const key = declarations(style);
    let i = palette.get(key);
    if (i === undefined) palette.set(key, (i = palette.size));
    return `bc${i}`;
  };

  const list = async () => {
    const out = [...rootFiles];
    for (const dir of roots) {
      const entries = await readdir(join(root, dir), { recursive: true, withFileTypes: true }).catch(() => []);
      for (const e of entries) {
        if (!e.isFile()) continue;
        const rel = relative(root, join(e.parentPath, e.name)).split(sep).join('/');
        if (rel.split('/').some(part => skipDirs.has(part)) || secret.test(rel)) continue;
        out.push(rel);
      }
    }
    return out.sort();
  };

  const allowed = (rel: string) =>
    (rootFiles.includes(rel) || roots.includes(rel.split('/')[0]!)) && !secret.test(rel) && !rel.includes('..');

  const analyze = async (rel: string): Promise<Entry> => {
    if (!allowed(rel)) throw new Error(`[bothub-code] refusing to read ${rel}`);
    const abs = join(root, rel);
    const { mtimeMs } = await stat(abs);
    const hit = cache.get(rel);
    if (hit && hit.mtime === mtimeMs) return hit;
    const raw = await readFile(abs, 'utf8');
    const lang = langOf(rel);
    const ts = lang === 'typescript' || lang === 'tsx' ? await analyzeTs(abs, raw, mtimeMs) : undefined;
    const entry: Entry = {
      mtime: mtimeMs,
      raw,
      meta: {
        path: rel,
        lines: raw.replace(/\n$/, '').split('\n').length,
        decls: ts?.decls ?? [],
        regions: regionsOf(raw),
        tables: ts?.tables ?? {},
      },
    };
    cache.set(rel, entry);
    return entry;
  };

  /** The file's lines as highlighted HTML, one string per line. Text in the default color is left bare. */
  const htmlLines = (entry: Entry) =>
    (entry.lines ??= highlight(entry.raw.replace(/\n$/, ''), langOf(entry.meta.path)).then(({ tokens, plain }) =>
      tokens.map(line =>
        line
          .map(t =>
            declarations(t.htmlStyle).toLowerCase() === plain
              ? escape(t.content)
              : `<span class="${classOf(t.htmlStyle)}">${escape(t.content)}</span>`
          )
          .join('')
      )
    ));

  const references = async () => {
    const pages = (await readdir(content, { recursive: true })).filter(p => p.endsWith('.mdx')).sort();
    const out: Found[] = [];
    for (const page of pages) {
      const text = await readFile(join(content, page), 'utf8');
      for (const m of text.matchAll(/<(Source|Sym|Fields)\s([^>]*?)\/?>/gs)) {
        const attrs = Object.fromEntries([...m[2]!.matchAll(/(\w+)="([^"]*)"/g)].map(a => [a[1]!, a[2]!]));
        const symbol = attrs.symbol ?? attrs.name;
        out.push({
          at: `${page}:${text.slice(0, m.index).split('\n').length}`,
          tag: m[1] as Tag,
          target: {
            ...(attrs.file && { file: attrs.file }),
            ...(symbol && { symbol }),
            ...(attrs.region && { region: attrs.region }),
          },
        });
      }
    }
    return out;
  };

  const render = async (tag: Tag, target: Found['target'], files: Files): Promise<Ref> => {
    const r = resolve(files, target);
    if ('error' in r) return r;
    const fields = r.file.tables[r.name];
    if (tag === 'Fields' && !fields)
      return { error: `${r.name} in ${r.file.path} is not an object type or zod object` };
    const doc = summary(r.doc);
    const lines = tag === 'Source' ? (await htmlLines(cache.get(r.file.path)!)).slice(r.start - 1, r.end) : [];
    return {
      path: r.file.path,
      name: r.name,
      start: r.start,
      end: r.end,
      ...(doc && { summary: doc }),
      ...(tag === 'Source' && { html: lines.map(l => `<span class="line">${l}</span>`).join('\n') }),
      ...(tag === 'Fields' && fields && { fields }),
    };
  };

  /** Every reference in the docs, resolved, plus one line per reference that does not resolve. */
  const collect = async () => {
    const entries = await Promise.all((await list()).map(analyze));
    const files: Files = Object.fromEntries(entries.map(e => [e.meta.path, e.meta]));
    const refs: Record<string, Ref> = {};
    const problems: string[] = [];
    for (const { at, tag, target } of await references()) {
      const key = refKey(tag, target);
      refs[key] ??= await render(tag, target, files);
      const ref = refs[key];
      if ('error' in ref) problems.push(`${at} <${tag}>: ${ref.error}`);
    }
    return { refs, problems };
  };

  const moduleCode = async () => {
    const { refs, problems } = await collect();
    const css = [...palette].map(([style, i]) => `.bc${i}{${style}}`).join('');
    const code = [
      `export const root = ${JSON.stringify(root)};`,
      `export const css = ${JSON.stringify(css)};`,
      `export const refs = ${JSON.stringify(refs)};`,
    ].join('\n');
    return { code, problems };
  };

  const fail = (problems: string[]) => `docs reference source that does not exist:\n  ${problems.join('\n  ')}`;

  const isWatched = (file: string) => {
    if (file.startsWith(content) && file.endsWith('.mdx')) return true;
    const rel = relative(root, file).split(sep).join('/');
    if (!allowed(rel)) return false;
    cache.delete(rel);
    return true;
  };

  return {
    name: 'bothub-code',
    enforce: 'pre',
    resolveId(id) {
      if (id === 'virtual:bothub-code') return '\0bothub-code';
    },
    async load(id) {
      if (id !== '\0bothub-code') return;
      const { code, problems } = await moduleCode();
      if (!server && problems.length) this.error(fail(problems));
      for (const p of problems) server?.config.logger.warn(`[bothub-code] ${p}`);
      served = code;
      return { code, moduleType: 'js' };
    },
    async buildStart() {
      if (server) return;
      const { problems } = await collect();
      if (problems.length) this.error(fail(problems));
    },
    configureServer(dev) {
      server = dev;
      dev.watcher.add([...roots, ...rootFiles].map(r => join(root, r)));
    },
    async hotUpdate({ file }) {
      if (this.environment.name !== 'client' || !isWatched(file)) return;
      const graph = this.environment.moduleGraph;
      const mod = graph.getModuleById('\0bothub-code');
      if (!mod || served === undefined) return;
      const { code, problems } = await moduleCode();
      for (const p of problems) this.environment.logger.warn(`[bothub-code] ${p}`);
      if (code === served) return;
      served = code;
      graph.invalidateModule(mod);
      this.environment.hot.send({ type: 'full-reload' });
      return [];
    },
  };
};
