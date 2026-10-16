// Fails when the README, the docs or a hub README names a command that does not exist: a `node bin/` file, a
// `bin/run.ts` subcommand, an npm script, or a `bothub <command>`, which has no binary. Usage: node bin/commands.mjs
import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const root = join(import.meta.dirname, '..');
const read = path => readFileSync(join(root, path), 'utf8');
const subcommands = new Set([...read('bin/run.ts').matchAll(/positionals\[0\] === '([\w-]+)'/g)].map(m => m[1]));
const scripts = dir => Object.keys(JSON.parse(read(join(dir, 'package.json'))).scripts ?? {});
const npm = new Set([...scripts('.'), ...scripts('studio')]);
const pages = [
  'README.md',
  'infra/github/README.md',
  ...readdirSync(join(root, 'docs')).flatMap(f => (f.endsWith('.md') ? [`docs/${f}`] : [])),
  ...readdirSync(join(root, 'examples')).flatMap(hub => {
    const path = `examples/${hub}/README.md`;
    return existsSync(join(root, path)) ? [path] : [];
  }),
];

const bad = [];
for (const page of pages) {
  read(page)
    .split('\n')
    .forEach((line, i) => {
      const at = `${page}:${i + 1}`;
      for (const [, file, sub] of line.matchAll(/node bin\/([\w.-]+)(?: ([a-z][\w-]*))?/g)) {
        if (!existsSync(join(root, 'bin', file))) bad.push(`${at}: bin/${file} does not exist`);
        else if (file === 'run.ts' && sub && !subcommands.has(sub)) bad.push(`${at}: bin/run.ts has no ${sub} command`);
      }
      for (const [, script] of line.matchAll(/npm (?:--prefix \w+ )?run(?: -s)? ([\w:-]+)/g))
        if (!npm.has(script)) bad.push(`${at}: there is no npm script ${script}`);
      for (const [, word] of line.matchAll(/`bothub ([a-z][\w-]*)/g))
        bad.push(`${at}: \`bothub ${word}\` names a binary that does not exist; say node bin/run.ts`);
    });
}
if (bad.length) {
  console.error(bad.join('\n'));
  process.exit(1);
}
console.log(`commands in ${pages.length} pages ok`);
