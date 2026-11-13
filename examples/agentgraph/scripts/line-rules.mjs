import { readCheckInputFiles } from './changes.mjs';

const code = /\.(ts|tsx|mts|cts|js|mjs)$/;
const markdown = /\.mdx?$/;
const comment = /^\s*(\/\/|\/\*|\*)|\s\/\/\s/;
const fence = /^\s*(```|~~~)/;

const kinds = (path, text) => {
  const rows = text.split('\n');
  if (code.test(path)) return rows.map(row => (comment.test(row) ? 'comment' : 'code'));
  if (!markdown.test(path)) return rows.map(() => 'text');
  let fenced = false;
  return rows.map(row => {
    if (fence.test(row)) {
      fenced = !fenced;
      return 'fence';
    }
    return fenced ? 'fence' : 'prose';
  });
};

export const scan = (rules, scanned = readCheckInputFiles()) => {
  const findings = [];
  for (const { path, text, lines } of scanned) {
    const kindByLine = kinds(path, text);
    for (const { line, text: row } of lines) {
      const kind = kindByLine[line - 1] ?? 'text';
      const body = kind === 'comment' ? row.slice(row.search(/\/\/|\/\*|\*/)) : row;
      for (const [where, pattern, message, unless] of rules) {
        if (!where(path, kind) || !pattern.test(body) || unless?.(path, row)) continue;
        findings.push(`${path}:${line}: ${message}`);
      }
    }
  }
  return findings;
};
