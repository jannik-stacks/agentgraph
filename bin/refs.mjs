// Links docs sections and code both ways through the `code: path#symbol` refs in docs/*.md.
//
//   node bin/refs.mjs                 fails when a ref names a missing file or symbol
//   node bin/refs.mjs --pairs         prints every pair: docs section, then the symbol it cites
//   node bin/refs.mjs --diff <base>   prints the pairs whose other side to re-check after the change since <base>
//   node bin/refs.mjs --coverage      lists what no docs page names; fails on uncited user-facing items
import { execFileSync } from 'node:child_process';
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

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
  return read(page)
    .split('\n')
    .flatMap((text, i) =>
      [...text.matchAll(/code: ([\w./-]+)#([\w$]+)/g)].map(([, file, symbol]) => ({
        page,
        anchor: sectionAt(sections, i + 1),
        line: i + 1,
        file,
        symbol,
      }))
    );
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

/** The lines a change since `base` touches in each file, on the new side. */
const touched = base => {
  const lines = new Map();
  const mark = (file, from, to) => {
    if (!lines.has(file)) lines.set(file, new Set());
    for (let n = from; n <= to; n++) lines.get(file).add(n);
  };
  let file = '';
  for (const row of git('diff', '-U0', '--no-color', '--no-renames', '--relative', base, '--', 'docs', 'src').split(
    '\n'
  )) {
    const name = /^\+\+\+ (?:b\/)?(.+)$/.exec(row)?.[1];
    if (name) file = name;
    const hunk = /^@@ -\S+ \+(\d+)(?:,(\d+))? @@/.exec(row);
    if (!hunk) continue;
    const start = Number(hunk[1]);
    const count = hunk[2] === undefined ? 1 : Number(hunk[2]);
    if (count > 0) mark(file, start, start + count - 1);
    else mark(file, start, start + 1);
  }
  for (const path of git('ls-files', '--others', '--exclude-standard', '--', 'docs', 'src').split('\n').filter(Boolean))
    mark(path, 1, read(path).split('\n').length);
  return lines;
};

const diff = base => {
  const changed = touched(base);
  const out = new Set();
  for (const p of pairs) {
    const doc = where(p.page, p.anchor);
    const code = `${p.file}#${p.symbol}`;
    const docLines = changed.get(p.page);
    if (docLines) {
      const sections = sectionsOf(p.page);
      if ([...docLines].some(n => sectionAt(sections, n) === p.anchor)) out.add(`docs changed: ${doc} cites ${code}`);
    }
    const codeLines = changed.get(p.file);
    const range = codeLines && existsSync(join(root, p.file)) && rangeOf(read(p.file), p.symbol);
    if (range && [...codeLines].some(n => n >= range.from && n <= range.to))
      out.add(`code changed: ${code} is cited by ${doc}`);
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
  for (const file of ['src/hub.ts', 'src/workflow.ts', 'src/engine.ts']) {
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
  const forge = read('src/forge.ts');
  const proposal = /export type Proposal =([\s\S]*?);\n\n/.exec(forge)?.[1] ?? '';
  add(
    'proposal kind',
    'src/forge.ts',
    [...proposal.matchAll(/kind: '(\w+)'/g)].map(m => m[1])
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
    [...cli.matchAll(/positionals\[0\] === '(\w+)'/g)].map(m => m[1])
  );
  for (const file of [...readdirSync(join(root, 'src')).map(f => `src/${f}`), 'bin/run.ts'])
    add(
      'env var',
      file,
      [...read(file).matchAll(/\bBOTHUB_[A-Z0-9_]+\b/g)].map(m => m[0])
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
  if (!args[1]) throw new Error('usage: node bin/refs.mjs --diff <base>');
  for (const line of diff(args[1])) console.log(line);
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
