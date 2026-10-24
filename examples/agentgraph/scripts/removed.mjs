// One JSON line per behavior the change removes from src/ or the hub scripts: a passed argument or object field, a
// branch or fallback (`??`, `||`, a ternary, an if or an else) and an export, with the removed lines, the file and
// line, and the hunks that replace them. A line the change adds back elsewhere is a move, not a removal. A reviewer
// who sees one hunk never asks who relied on the line that went.
import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, readBaseShaFromEnv, changedFiles, readChangeDiff } from './changes.mjs';

const roots = ['src', 'examples/agentgraph/scripts'];
const maxChars = 4000;
const branches = /\?\?|\|\||(?<![?.])\?(?![.?:])|\bif\b|\belse\b/g;
const exported = /^export\s+(?:declare\s+)?(?:async\s+)?(?:const|let|function\*?|type|interface|class|enum)\s+([A-Za-z_$][\w$]*)/;
const trivial = /^(\/\/|\/?\*|import\b|[\]})]+[;,]?$)/;

const count = (rows, pattern) => rows.join('\n').match(pattern)?.length ?? 0;

const sha = readBaseShaFromEnv();
const added = new Set();
const addedText = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !roots.some(root => path.startsWith(`${root}/`))) continue;
  for (const { text } of addedLines(sha, path)) {
    added.add(text.trim());
    addedText.push(text);
  }
}

const diff = readChangeDiff(sha, roots, 0);

const items = new Map();
const push = (kind, file, line, removed, hunk) => {
  const item = items.get(`${file} ${kind}`) ?? { path: `${file}:${line} ${kind}`, kind, file, line, removed: [], replacing: [] };
  item.removed.push(...removed);
  item.replacing.push(hunk);
  items.set(`${file} ${kind}`, item);
};

for (const part of diff.split(/^diff --git /m).slice(1)) {
  const file = /^a\/(.+?) b\//.exec(part)[1];
  for (const hunk of part.split(/^(?=@@ )/m).slice(1)) {
    const rows = hunk.split('\n').slice(1);
    const gone = rows.filter(row => row.startsWith('-')).map(row => row.slice(1)).filter(text => !trivial.test(text.trim()) && !added.has(text.trim()));
    const come = rows.filter(row => row.startsWith('+')).map(row => row.slice(1));
    const line = Number(/^@@ -\S+ \+(\d+)/.exec(hunk)[1]);
    const shown = `@@ ${file}:${line}\n${rows.filter(row => /^[-+]/.test(row)).join('\n')}`.slice(0, maxChars);
    const nowhere = word => !come.join('\n').includes(word) && !addedText.some(row => row.includes(word));
    const exports = gone.filter(row => exported.test(row.trim()) && !addedText.some(t => new RegExp(`\\bexport\\b.*\\b${exported.exec(row.trim())[1]}\\b`).test(t)));
    const rest = gone.filter(row => !exports.includes(row));
    const branching = count(rest, branches) > count(come, branches) ? rest.filter(row => count([row], branches)) : [];
    const args = rest.filter(
      row =>
        !branching.includes(row) &&
        ((row.match(/[\w$]+(?:\.[\w$]+)+/g) ?? []).some(nowhere) ||
          (/^\s*([\w$]+):.*,$/.test(row) && nowhere(`${/^\s*([\w$]+):/.exec(row)[1]}`)))
    );
    for (const [kind, removed] of [['export', exports], ['branch', branching], ['argument', args]])
      if (removed.length) push(kind, file, line, removed.map(row => row.trim()), shown);
  }
}

const text = findBrief();
const brief = text ? parseBrief(text) : undefined;
for (const { replacing, ...item } of items.values())
  console.log(JSON.stringify({ ...item, replacing: replacing.join('\n').slice(0, maxChars), ...(brief && { task: brief.task, criteria: brief.criteria.map(c => c.text), 'out of scope': brief.outOfScope }) }));
