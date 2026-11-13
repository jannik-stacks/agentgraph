import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { readUsage } from './usage.mjs';

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
  ...names('examples').flatMap(graph =>
    existsSync(join(root, `examples/${graph}/README.md`)) ? [`examples/${graph}/README.md`] : []
  ),
  ...bins.map(f => `bin/${f}`),
];

const takes = file => readUsage(root, `bin/${file}`);
const known = Object.fromEntries(bins.map(f => [f, takes(f)]));
known['../infra/local/sandbox/agi.mjs'] = takes('../infra/local/sandbox/agi.mjs');
const table = takes('../src/cli.ts');
known['run.ts'] = {
  flags: new Set([...known['run.ts'].flags, ...table.flags]),
  words: new Set([...known['run.ts'].words, ...table.words]),
};
const everyFlag = new Set(Object.values(known).flatMap(k => [...k.flags]));

const bad = [];
const check = (at, line, own) => {
  for (const [, path, rest] of line.matchAll(/(node bin\/[\w.-]+|\bagi(?= ))([^`]*)/g)) {
    const file =
      path === 'agi'
        ? /^ file(?: |$)/.test(rest)
          ? '../infra/local/sandbox/agi.mjs'
          : 'run.ts'
        : path.slice('node bin/'.length);
    if (!known[file]) {
      bad.push(`${at}: bin/${file} does not exist`);
      continue;
    }
    for (const [, flag] of rest.matchAll(/(?:^|\s|\[)--([a-z][\w-]*)/g))
      if (!known[file].flags.has(flag)) bad.push(`${at}: bin/${file} has no --${flag} option`);
    const word = path === 'agi' || file === 'run.ts' ? /^ ([a-z][\w-]*)/.exec(rest)?.[1] : undefined;
    if (word && !known[file].words.has(word)) bad.push(`${at}: bin/${file} has no ${word} command`);
  }
  if (own)
    for (const [, flag] of line.matchAll(/(?:^|[\s`(])--([a-z][\w-]*)/g))
      if (!known[own].flags.has(flag) && !/node bin\/|\bagi /.test(line))
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
