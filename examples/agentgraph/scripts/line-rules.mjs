// Pattern rules over the lines a change adds, or over every tracked line with `--all`. Each line has a kind: a code
// line or a comment in a code file, prose or fenced code in a markdown file, or plain text anywhere else.
import { readCheckInputFiles } from './changes.mjs';

const code = /\.(ts|tsx|mts|cts|js|mjs)$/;
const markdown = /\.mdx?$/;
const comment = /^\s*(\/\/|\/\*|\*)|\s\/\/\s/;
const fence = /^\s*(```|~~~)/;

/** The kind of every line of a file, by line number. */
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

/**
 * Every line that matches a rule, as `path:line: message`. A rule is `[where, pattern, message, unless?]`: `where(path,
 * kind)` picks the lines, `pattern` is tested against the line, or only the comment part of a comment, and
 * `unless(path, text)` lets a line go.
 */
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
