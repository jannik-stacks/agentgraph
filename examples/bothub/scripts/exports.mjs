// One JSON line per export the change adds to src/, with the existing exports whose names share a word with it, so
// a small model can say whether one of them already does the job. An export with no such neighbour is left out.
import { execFileSync } from 'node:child_process';
import { addedLines, base, changedFiles } from './changes.mjs';

const declaration = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const generic = new Set(['options', 'type', 'types', 'result', 'value', 'data', 'input', 'output', 'default', 'props']);
const words = name =>
  name
    .replace(/([a-z\d])([A-Z])/g, '$1 $2')
    .toLowerCase()
    .split(/[^a-z\d]+/)
    .filter(word => word.length > 2 && !generic.has(word));
const maxNeighbours = 6;

const grep = sha => {
  try {
    return execFileSync('git', ['grep', '-n', '-E', '^export ', sha, '--', 'src/'], { encoding: 'utf8' });
  } catch (e) {
    if (e.status === 1) return '';
    throw e;
  }
};

const sha = base();
const existing = grep(sha)
  .split('\n')
  .flatMap(row => {
    const m = /^[^:]+:([^:]+):(\d+):(.*)$/.exec(row);
    const name = m && declaration.exec(m[3])?.[1];
    return name ? [{ file: m[1], line: Number(m[2]), name, code: m[3].trim().slice(0, 160) }] : [];
  });
const known = new Set(existing.map(e => `${e.file}:${e.name}`));

for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !/^src\/.*\.(ts|mts)$/.test(path)) continue;
  for (const { line, text } of addedLines(sha, path)) {
    const name = declaration.exec(text)?.[1];
    if (!name || known.has(`${path}:${name}`)) continue;
    const mine = new Set(words(name));
    const neighbours = existing
      .map(e => ({ ...e, shared: words(e.name).filter(word => mine.has(word)).length }))
      .filter(e => e.shared && e.name !== name)
      .sort((a, b) => b.shared - a.shared)
      .slice(0, maxNeighbours)
      .map(({ file, line: at, code }) => `${file}:${at}: ${code}`);
    if (neighbours.length) console.log(JSON.stringify({ file: path, line, export: text.trim().slice(0, 300), neighbours }));
  }
}
