// One JSON line per docs paragraph that names an export the change touches in src/, so a page the change leaves
// alone is still read against the new code. A touched export is one whose declaration, with the comment above it,
// holds a changed line.
//
//   node docs-mentions.mjs <code-root> <docs-root>      e.g. node docs-mentions.mjs src/ docs/
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { readBaseShaFromEnv, changedFiles, readChangeDiff } from './changes.mjs';

const [code, docs] = process.argv.slice(2);
if (!code || !docs) throw new Error('usage: docs-mentions.mjs <code-root> <docs-root>');

const declaration = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const comment = /^\s*(\/\*|\*|\/\/)/;

/** The exports of `lines` with the first line of each one's comment, in order. */
const findExports = lines =>
  lines.flatMap((text, i) => {
    const name = declaration.exec(text)?.[1];
    if (!name) return [];
    let from = i;
    while (from > 0 && comment.test(lines[from - 1])) from--;
    return [{ name, from }];
  });

const sha = readBaseShaFromEnv();
const touched = new Map();
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !path.startsWith(code) || !/\.(ts|tsx|mts)$/.test(path)) continue;
  const lines = readFileSync(path, 'utf8').split('\n');
  const owners = findExports(lines);
  const ranges = [...readChangeDiff(sha, [path], 0).matchAll(/^@@ -\S+ \+(\d+)(?:,(\d+))? @@/gm)].map(([, at, n = '1']) => [
    Number(at) - 1,
    Number(at) - 1 + Math.max(Number(n), 1),
  ]);
  owners.forEach(({ name, from }, i) => {
    const to = owners[i + 1]?.from ?? lines.length;
    if (ranges.some(([start, end]) => start < to && end > from)) touched.set(name, path);
  });
}

const pages = execFileSync('git', ['ls-files', docs], { encoding: 'utf8' }).split('\n').filter(Boolean);
for (const file of pages) {
  let line = 1;
  for (const paragraph of readFileSync(file, 'utf8').split(/\n{2,}/)) {
    const names = [...touched.keys()].filter(name =>
      new RegExp(`(?<![\\w$])${name.replace(/\$/g, '\\$')}(?![\\w$])`).test(paragraph)
    );
    if (names.length)
      console.log(
        JSON.stringify({ file, line, hunk: paragraph, 'changed code': names.map(name => `${name} in ${touched.get(name)}`) })
      );
    line += paragraph.split('\n').length + 1;
  }
}
