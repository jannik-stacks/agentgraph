// Finds a list of string literals the change adds that holds every value of a string union the code declares, or all
// but one: a copy that misses the next value the union gains. Read the values from the declaration instead. Also finds
// a number the change sets or compares under a name that src/ and a graph script both give that number, such as
// `calls !== 5` in the engine and `calls: 5` in a script: two copies of one limit that drift apart.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { addedLines, readBaseShaFromEnv, changedFiles, report } from './changes.mjs';

const code = /^(src|studio\/src|examples\/[^/]+\/scripts)\/.*\.(ts|tsx|mts|js|mjs)$/;
const quoted = text => [...text.matchAll(/['"`]([\w-]+)['"`]/g)].map(m => m[1]);
const declared = /type (\w+)\s*=((?:\s*\|?\s*['"][\w-]+['"])+)\s*;|(\w+)\s*=\s*z\.enum\(\[([^\]]*)\]/g;
const list = /(?<!z\.enum\()\[(\s*(?:['"`][\w-]+['"`]\s*,\s*)+['"`][\w-]+['"`]\s*,?\s*)\]/g;
const ls = (...paths) => execFileSync('git', ['ls-files', '-co', '--exclude-standard', ...paths], { encoding: 'utf8' }).split('\n');

const unions = ls('src', 'studio/src')
  .filter(path => /\.tsx?$/.test(path))
  .flatMap(path =>
    [...readFileSync(path, 'utf8').matchAll(declared)].map(m => ({ name: m[1] ?? m[3], path, values: quoted(m[2] ?? m[4]) }))
  )
  .filter(({ values }) => values.length >= 3);

const engine = /^src\/.*\.ts$/;
const script = /^examples\/[^/]+\/scripts\/.*\.m?js$/;
const named = text =>
  [...text.matchAll(/\b(\w+)\s*(?:[!=]==?|[<>]=?|:)\s*(\d+(?:\.\d+)?)\b(?!['"])/g)]
    .filter(m => m[1] !== 'length' && !['0', '1', '2'].includes(m[2]))
    .map(m => `${m[1]} = ${m[2]}`);
const where = paths => new Map(paths.flatMap(path => named(readFileSync(path, 'utf8')).map(pair => [pair, path])));
const [engineNumbers, scriptNumbers] = [ls('src').filter(p => engine.test(p)), ls('examples').filter(p => script.test(p))].map(where);

const sha = readBaseShaFromEnv();
const findings = [];
for (const { path } of changedFiles(sha).filter(f => !f.deleted && code.test(f.path))) {
  const lines = addedLines(sha, path);
  const text = lines.map(({ text }) => text).join('\n');
  for (const m of text.matchAll(list)) {
    const values = new Set(quoted(m[1]));
    const line = lines[text.slice(0, m.index).split('\n').length - 1].line;
    for (const union of unions)
      if (values.size >= 3 && [...values].every(v => union.values.includes(v)) && values.size >= union.values.length - 1)
        findings.push(`${path}:${line}: copies the values of ${union.name} in ${union.path}; read them from there instead`);
  }
  const other = engine.test(path) ? scriptNumbers : script.test(path) ? engineNumbers : new Map();
  for (const { line, text } of lines)
    for (const pair of named(text).filter(pair => other.has(pair)))
      findings.push(`${path}:${line}: \`${pair}\` is also in ${other.get(pair)}; keep the number in one place`);
}
report('enum-copy', findings);
