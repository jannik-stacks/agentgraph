// One JSON line per hunk the change makes under the given roots, with surrounding code so it reads on its own. Hunks
// that only touch comments or blank lines are left out: the rules check covers them. So are hunks that only make
// the change's rename (see size.mjs): the types and tests checks cover a rename, and it would crowd out the rest. A new
// file is one item.
//
//   node hunks.mjs <root>...      e.g. node hunks.mjs src/
import { readFileSync } from 'node:fs';
import { base, changedFiles, diffOf, inBase, renameOf, swapIn } from './changes.mjs';

const roots = process.argv.slice(2);
if (!roots.length) throw new Error('usage: hunks.mjs <root>...');

const context = 8;
const maxLines = 200;
const clip = lines => (lines.length > maxLines ? [...lines.slice(0, maxLines), '[clipped]'] : lines).join('\n');
const code = /\.(ts|tsx|mts|cts|js|mjs)$/;

const sha = base();
const changed = changedFiles(sha);
const { rename } = renameOf(sha, changed);
const files = changed.filter(({ path }) => roots.some(root => path.startsWith(root)));
for (const { path, deleted } of files) {
  const trivial = code.test(path) ? line => /^[+-]\s*(\/\/.*|\/\*.*|\*.*|)$/.test(line) : line => /^[+-]\s*$/.test(line);
  if (!deleted && !inBase(sha, path)) {
    const lines = readFileSync(path, 'utf8').split('\n');
    if (lines.some(line => !trivial(`+${line}`)))
      console.log(JSON.stringify({ file: path, line: 1, hunk: clip(lines.map(line => `+${line}`)) }));
    continue;
  }
  const [, ...parts] = diffOf(sha, [path], context).split(/^(?=@@ )/m);
  for (const part of parts) {
    const lines = part.trimEnd().split('\n');
    const changes = lines.slice(1).filter(line => /^[+-]/.test(line));
    if (changes.every(trivial)) continue;
    if (rename && swapIn(part) === rename) continue;
    const line = Number(/^@@ -\S+ \+(\d+)/.exec(lines[0])?.[1] ?? 1);
    console.log(JSON.stringify({ file: path, line, hunk: clip(lines) }));
  }
}
