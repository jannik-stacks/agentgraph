// Links docs sections and code both ways through the `<!-- code: path#symbol -->` comments in docs/*.md.
// A comment sits after the text it backs and is invisible to readers.
//
//   node bin/refs.mjs                           fails when a ref names a missing file or symbol
//   node bin/refs.mjs --pairs                   prints every pair: docs section, then the symbol it cites
//   node bin/refs.mjs --diff <base> [--staged]  prints what to re-check after the change since <base>, or the staged
//                                               change: the other side of each pair that changed on one side only,
//                                               and the docs sections that cite the same symbol
//   node bin/refs.mjs --coverage      lists what no docs page names; fails on uncited user-facing items
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Proposal, Said } from '../src/proposal.ts';

const root = join(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const pages = readdirSync(join(root, 'docs'))
  .filter(f => f.endsWith('.md'))
  .sort()
  .map(f => `docs/${f}`);

/** GitHub's heading anchor: lower case, punctuation dropped, spaces to dashes. */
const slug = heading =>
  heading
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s_-]/gu, '')
    .replace(/ /g, '-');

/** Each page's sections: heading anchor and first line, outside fenced code. */
const sectionsOf = page => {
  const sections = [{ anchor: '', from: 1 }];
  let fenced = false;
  read(page)
    .split('\n')
    .forEach((line, i) => {
      if (/^(```|~~~)/.test(line)) fenced = !fenced;
      const heading = !fenced && /^#{1,6}\s+(.+?)\s*$/.exec(line);
      if (heading) sections.push({ anchor: i === 0 ? '' : slug(heading[1]), from: i + 1 });
    });
  return sections;
};
const sectionAt = (sections, line) => sections.findLast(s => s.from <= line).anchor;
const where = (page, anchor) => (anchor ? `${page}#${anchor}` : page);

/** Every ref as a pair of a docs section and a symbol. */
const pairs = pages.flatMap(page => {
  const sections = sectionsOf(page);
  let fenced = false;
  return read(page)
    .split('\n')
    .flatMap((text, i) => {
      if (/^(```|~~~)/.test(text)) fenced = !fenced;
      if (fenced) return [];
      return [...text.replace(/`[^`]*`/g, '').matchAll(/<!--\s*code:([^>]*?)-->/g)].flatMap(([, body]) =>
        [...body.matchAll(/([\w./-]+)#([\w$]+)/g)].map(([, file, symbol]) => ({
          page,
          anchor: sectionAt(sections, i + 1),
          line: i + 1,
          file,
          symbol,
        }))
      );
    });
});

const declaration = name =>
  new RegExp(
    `^(export\\s+)?(default\\s+)?(declare\\s+)?(async\\s+)?(const|let|var|function\\*?|class|type|interface|enum)\\s+${name.replace(/\$/g, '\\$')}\\b`
  );

/** The lines of a top-level declaration, with the comment above it, in formatted source. */
const rangeOf = (text, name) => {
  const lines = text.split('\n');
  const at = lines.findIndex(line => declaration(name).test(line));
  if (at < 0) return undefined;
  let from = at;
  while (from > 0 && /^(\/\*\*|\s*\*|\/\/)/.test(lines[from - 1])) from--;
  let to = at + 1;
  while (to < lines.length && !/^[^\s})\]]/.test(lines[to])) to++;
  return { from: from + 1, to };
};

const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', maxBuffer: 64 << 20 });

/** The lines a change since `base` (the staged one with `staged`) touches in each file, on the new side. */
const touched = (base, staged) => {
  const lines = new Map();
  const mark = (file, from, to) => {
    if (!lines.has(file)) lines.set(file, new Set());
    for (let n = from; n <= to; n++) lines.get(file).add(n);
  };
  let file = '';
  const args = ['diff', '-U0', '--no-color', '--no-renames', '--relative', base, '--', 'docs', 'src'];
  if (staged) args.splice(1, 0, '--cached');
  for (const row of git(...args).split('\n')) {
    const name = /^\+\+\+ (?:b\/)?(.+)$/.exec(row)?.[1];
    if (name) file = name;
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) mark(file, start, start + count - 1);
    else mark(file, start, start + 1);
  }
  if (!staged)
    for (const path of git('ls-files', '--others', '--exclude-standard', '--', 'docs', 'src')
      .split('\n')
      .filter(Boolean))
      mark(path, 1, read(path).split('\n').length);
  return lines;
};

/** What to re-check: the other side of each pair that changed on one side only, and the docs sections citing the same symbol. */
const diff = (base, staged) => {
  const changed = touched(base, staged);
  const sections = new Map(pages.map(page => [page, sectionsOf(page)]));
  const docsChanged = p => [...(changed.get(p.page) ?? [])].some(n => sectionAt(sections.get(p.page), n) === p.anchor);
  const codeChanged = p => {
    const lines = changed.get(p.file);
    const range = lines && existsSync(join(root, p.file)) && rangeOf(read(p.file), p.symbol);
    return !!range && [...lines].some(n => n >= range.from && n <= range.to);
  };
  const out = new Set();
  for (const p of pairs) {
    const doc = where(p.page, p.anchor);
    const code = `${p.file}#${p.symbol}`;
    const byDocs = docsChanged(p);
    if (byDocs === codeChanged(p)) continue;
    if (!byDocs) out.add(`code changed: ${code} is cited by ${doc}`);
    else {
      out.add(`docs changed: ${doc} cites ${code}`);
      for (const q of pairs) {
        const sibling = where(q.page, q.anchor);
        if (q.file === p.file && q.symbol === p.symbol && sibling !== doc && !docsChanged(q))
          out.add(`docs changed: ${sibling} also cites ${code}`);
      }
    }
  }
  return [...out].sort();
};

/** The text of a `(`, `{` or `[` at `open` up to its match. */
const balanced = (s, open) => {
  let depth = 0;
  for (let i = open; i < s.length; i++) {
    if ('({['.includes(s[i])) depth++;
    if (')}]'.includes(s[i]) && --depth === 0) return s.slice(open + 1, i);
  }
  return '';
};
const topLevel = body => {
  const pieces = [''];
  let depth = 0;
  for (const c of body) {
    if ('({['.includes(c)) depth++;
    if (')}]'.includes(c)) depth--;
    if (c === ',' && depth === 0) pieces.push('');
    else pieces[pieces.length - 1] += c;
  }
  return pieces;
};
const strings = text => [...text.matchAll(/'([^']+)'/g)].map(m => m[1]);

/** What a hub author, an agent or an operator writes or reads: schema keys and values, proposal kinds, statuses, CLI flags, env vars. */
const userFacing = () => {
  const items = [];
  const add = (what, from, names) => names.forEach(name => items.push({ what, from, name }));
  for (const file of ['src/hub.ts', 'src/workflow.ts']) {
    const text = read(file);
    for (const m of text.matchAll(/Schema\.Struct\(\{/g)) {
      for (const piece of topLevel(balanced(text, m.index + m[0].length - 1))) {
        const key = /^\s*(\w+)\s*:/.exec(piece)?.[1];
        if (!key) continue;
        add('field', file, [/fromKey\('([^']+)'\)/.exec(piece)?.[1] ?? key]);
        for (const lit of piece.matchAll(/Schema\.Literal\(([^)]*)\)/g)) add('value', file, strings(lit[1]));
      }
    }
    for (const lit of text.matchAll(/EventName = Schema\.Literal\(([^)]*)\)/g)) add('value', file, strings(lit[1]));
  }
  const literals = ast =>
    ast._tag === 'Literal' ? [ast.literal] : ast._tag === 'Union' ? ast.types.flatMap(literals) : [];
  for (const { propertySignatures } of Said.ast.types)
    for (const p of propertySignatures) {
      add('field', 'src/proposal.ts', [p.name]);
      add('value', 'src/proposal.ts', literals(p.type));
    }
  add(
    'proposal kind',
    'src/proposal.ts',
    Proposal.ast.types.flatMap(m => literals(m.propertySignatures.find(p => p.name === 'kind').type))
  );
  add('status', 'src/workflow.ts', strings(/status: ([^;]+);/.exec(read('src/workflow.ts'))?.[1] ?? ''));
  const context = read('src/context.ts');
  add(
    'status label',
    'src/context.ts',
    strings(balanced(context, context.indexOf('{', context.indexOf('const statuses'))))
  );
  const cli = read('bin/run.ts');
  add(
    'CLI flag',
    'bin/run.ts',
    [...balanced(cli, cli.indexOf('{', cli.indexOf('options:'))).matchAll(/(\w+): \{/g)].map(m => `--${m[1]}`)
  );
  add(
    'CLI command',
    'bin/run.ts',
    [...cli.matchAll(/(?:case|verb ===) '([\w-]+)'/g)].map(m => m[1])
  );
  for (const file of [...readdirSync(join(root, 'src')).map(f => `src/${f}`), 'bin/run.ts'])
    add(
      'env var',
      file,
      [...read(file).matchAll(/\bAGENTGRAPH_[A-Z0-9_]+\b/g)].map(m => m[0])
    );
  const seen = new Set();
  return items.filter(i => !seen.has(`${i.what} ${i.name}`) && seen.add(`${i.what} ${i.name}`));
};

/** The code in a page: fenced blocks whole, and inline code spans elsewhere. */
const codeOf = page => {
  let fence = '';
  return read(page)
    .split('\n')
    .flatMap(line => {
      const marker = /^\s*(`{3,}|~{3,})/.exec(line)?.[1];
      if (marker && !fence) fence = marker;
      else if (marker && marker === fence) fence = '';
      return fence || marker ? [line] : (line.match(/`[^`]+`/g) ?? []);
    })
    .join('\n');
};

const coverage = () => {
  const code = pages.map(codeOf).join('\n');
  const named = name => new RegExp(`(^|[^\\w-])${name.replace(/[.$]/g, '\\$&')}([^\\w-]|$)`, 'm').test(code);
  const uncited = userFacing().filter(i => !named(i.name));
  const cited = new Set(pairs.map(p => `${p.file}#${p.symbol}`));
  const internal = readdirSync(join(root, 'src'))
    .flatMap(f =>
      [...read(`src/${f}`).matchAll(/^export (?:const|function|class|type|interface) (\w+)/gm)].map(
        m => `src/${f}#${m[1]}`
      )
    )
    .filter((ref, i, all) => !cited.has(ref) && all.indexOf(ref) === i);
  for (const i of uncited) console.log(`uncited ${i.what}: ${i.name} (${i.from})`);
  for (const ref of internal) console.log(`uncited export: ${ref}`);
  console.log(`${uncited.length} uncited user-facing item(s), ${internal.length} uncited export(s)`);
  return uncited.length === 0;
};

const args = process.argv.slice(2);
if (args[0] === '--pairs') for (const p of pairs) console.log(`${where(p.page, p.anchor)} ${p.file}#${p.symbol}`);
else if (args[0] === '--diff') {
  if (!args[1]) throw new Error('usage: node bin/refs.mjs --diff <base> [--staged]');
  for (const line of diff(args[1], args.includes('--staged'))) console.log(line);
} else if (args[0] === '--coverage') process.exit(coverage() ? 0 : 1);
else {
  const bad = pairs.flatMap(({ page, line, file, symbol }) =>
    !existsSync(join(root, file))
      ? [`${page}:${line}: ${file} does not exist`]
      : !rangeOf(read(file), symbol)
        ? [`${page}:${line}: ${symbol} is not declared at the top of ${file}`]
        : []
  );
  if (bad.length) {
    console.error(bad.join('\n'));
    process.exit(1);
  }
  console.log(`${pairs.length} code refs ok`);
}
