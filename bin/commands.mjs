// Fails when the README, the docs, a hub README or a usage header in bin/ names a command that does not exist: a
// `node bin/` file, its subcommand, a flag it does not read, or an npm script. `npx agentgraph` stands for
// `node bin/run.ts`. Usage: node bin/commands.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const scripts = dir => Object.keys(JSON.parse(read(join(dir, 'package.json'))).scripts ?? {});
const npm = new Set([...scripts('.'), ...scripts('studio')]);
const names = dir => (existsSync(join(root, dir)) ? readdirSync(join(root, dir)) : []);
const bins = names('bin').filter(f => /\.(ts|mjs)$/.test(f));
const docs = ['README.md', ...names('docs').flatMap(f => (f.endsWith('.md') ? [`docs/${f}`] : []))];
const pages = [
  ...docs,
  'infra/github/README.md',
  ...names('examples').flatMap(hub =>
    existsSync(join(root, `examples/${hub}/README.md`)) ? [`examples/${hub}/README.md`] : []
  ),
  ...bins.map(f => `bin/${f}`),
];

/** The text inside the braces that follow the first match of `open`. */
const braced = (text, open) => {
  const at = open.exec(text);
  if (!at) return undefined;
  let depth = 0;
  for (let i = at.index + at[0].length - 1; i < text.length; i++) {
    if (text[i] === '{') depth++;
    if (text[i] === '}' && --depth === 0) return text.slice(at.index + at[0].length, i);
  }
};

/** What a bin file takes: its parseArgs options or its quoted `'--flag'` literals, and its `case` or `verb ===` words. */
const takes = file => {
  const code = read(`bin/${file}`)
    .split('\n')
    .filter(line => !/^\s*(\/\/|\/?\*)/.test(line))
    .join('\n');
  const options = braced(code, /options:\s*\{/);
  const flags = options
    ? [...options.matchAll(/(?:^|[\n,{])\s*(?:'([\w-]+)'|(\w+)):\s*\{\s*type/g)].map(m => m[1] ?? m[2])
    : [...code.matchAll(/'--([\w-]+)'/g)].map(m => m[1]);
  const words = [...code.matchAll(/(?:case|verb ===) '([\w-]+)'/g)].map(m => m[1]);
  return { flags: new Set(flags), words: new Set(words) };
};
const known = Object.fromEntries(bins.map(f => [f, takes(f)]));
const everyFlag = new Set(Object.values(known).flatMap(k => [...k.flags]));

const bad = [];
const check = (at, line, own) => {
  for (const [, path, rest] of line.matchAll(/(node bin\/[\w.-]+|npx agentgraph)([^`]*)/g)) {
    const file = path === 'npx agentgraph' ? 'run.ts' : path.slice('node bin/'.length);
    if (!known[file]) {
      bad.push(`${at}: bin/${file} does not exist`);
      continue;
    }
    for (const [, flag] of rest.matchAll(/(?:^|\s|\[)--([a-z][\w-]*)/g))
      if (!known[file].flags.has(flag)) bad.push(`${at}: bin/${file} has no --${flag} option`);
    const word = file === 'run.ts' ? /^ ([a-z][\w-]*)/.exec(rest)?.[1] : undefined;
    if (word && !known[file].words.has(word)) bad.push(`${at}: bin/${file} has no ${word} command`);
  }
  if (own)
    for (const [, flag] of line.matchAll(/(?:^|[\s`(])--([a-z][\w-]*)/g))
      if (!known[own].flags.has(flag) && !/node bin\/|npx agentgraph/.test(line))
        bad.push(`${at}: bin/${own} has no --${flag} option`);
};

for (const page of pages) {
  const own = page.startsWith('bin/') ? page.slice(4) : undefined;
  const inHeader = own && own.endsWith('.mjs') ? line => line.startsWith('//') : line => /^\s*(\/\*\*|\*)/.test(line);
  read(page)
    .split('\n')
    .forEach((line, i) => {
      const at = `${page}:${i + 1}`;
      if (!own || inHeader(line)) check(at, line, own && inHeader(line) ? own : undefined);
      if (docs.includes(page) && page !== 'docs/sandbox.md')
        for (const [, flag] of line.matchAll(/`--([a-z][\w-]*)/g))
          if (!everyFlag.has(flag)) bad.push(`${at}: no bin file reads --${flag}`);
      for (const [, script] of line.matchAll(/npm (?:--prefix \w+ )?run(?: -s)? ([\w:-]+)/g))
        if (!npm.has(script)) bad.push(`${at}: there is no npm script ${script}`);
    });
}
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log(`commands in ${pages.length} pages ok`);
