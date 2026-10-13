// Finds a list of string literals the change adds that holds every value of a string union the code declares, or all
// but one: a copy that misses the next value the union gains. Read the values from the declaration instead.
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { addedLines, base, changedFiles, report } from './changes.mjs';

const code = /^(src|studio\/src|examples\/[^/]+\/scripts)\/.*\.(ts|tsx|mts|js|mjs)$/;
const quoted = text => [...text.matchAll(/['"`]([\w-]+)['"`]/g)].map(m => m[1]);
const declared = /type (\w+)\s*=((?:\s*\|?\s*['"][\w-]+['"])+)\s*;|(\w+)\s*=\s*z\.enum\(\[([^\]]*)\]/g;
const list = /(?<!z\.enum\()\[(\s*(?:['"`][\w-]+['"`]\s*,\s*)+['"`][\w-]+['"`]\s*,?\s*)\]/g;

const unions = execFileSync('git', ['ls-files', 'src', 'studio/src'], { encoding: 'utf8' })
  .split('\n')
  .filter(path => /\.tsx?$/.test(path))
  .flatMap(path =>
    [...readFileSync(path, 'utf8').matchAll(declared)].map(m => ({ name: m[1] ?? m[3], path, values: quoted(m[2] ?? m[4]) }))
  )
  .filter(({ values }) => values.length >= 3);

const sha = base();
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
}
report('enum-copy', findings);
