// One JSON line per src/ file the change adds exports to: those exports, and the existing exports whose names share a
// word with one of them, so a small model can say whether one already does the job. An export with no such neighbour
// is left out, and a file with none of them.
import { addedLines, base, changedFiles } from './changes.mjs';
import { declaration, existingExports, sharingWords } from './neighbours.mjs';

const maxNeighbours = 10;

const sha = base();
const existing = existingExports(sha, ['src/']);
const known = new Set(existing.map(e => `${e.file}:${e.name}`));

for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !/^src\/.*\.(ts|mts)$/.test(path)) continue;
  const exports = [];
  const neighbours = new Map();
  for (const { line, text } of addedLines(sha, path)) {
    const name = declaration.exec(text)?.[1];
    if (!name || known.has(`${path}:${name}`)) continue;
    const near = sharingWords(name, existing);
    if (!near.length) continue;
    exports.push(`${line}: ${text.trim().slice(0, 300)}`);
    for (const [key, shared] of near) neighbours.set(key, Math.max(shared, neighbours.get(key) ?? 0));
  }
  const nearest = [...neighbours].sort((a, b) => b[1] - a[1]).slice(0, maxNeighbours).map(([key]) => key);
  if (exports.length) console.log(JSON.stringify({ file: path, exports, neighbours: nearest }));
}
