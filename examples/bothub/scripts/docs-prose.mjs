// Docs prose a change adds reads as written by a person who knows the code: no dates, names or internal references,
// none of the filler words models reach for, and code shown as short excerpts tied to a symbol.
import { addedLines, base, changedFiles, report } from './changes.mjs';
import { readFileSync } from 'node:fs';

const docs = /^studio\/content\/docs\/.*\.mdx?$/;
const longest = 30;

const rules = [
  [/\b20\d\d-\d\d-\d\d\b/, 'a date'],
  [/\bMorgan\b|\b(as )?(requested|suggested|asked) by\b/i, 'a name or an attribution'],
  [/\bresearch\/\d+|\bdecision\s+#?\d{2,4}\b|\b[DQPC]-\d{2,3}\b/, 'an internal reference; link the page instead'],
  [/\b(we|I) (decided|changed|renamed|used to)\b|\b(renamed (from|to)|formerly|previously|no longer)\b/i, 'history; say what it does now'],
  [/\b(delve|leverag(e|es|ing)|robust|comprehensive|crucial|powerful|seamless|effortless(ly)?|elevate|unlock|empower)\b/i, 'a filler word'],
  [/\b(it'?s worth noting|in summary|in conclusion|at its core|simply put)\b/i, 'a filler phrase'],
];

const sourceTag = /<Source\b[^>]*\bfile="([^"]+)"[^>]*>/;

const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !docs.test(path)) continue;
  const added = new Set();
  let fenced = false;
  for (const { line, text } of addedLines(sha, path)) {
    added.add(line);
    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
    if (fenced) continue;
    for (const [pattern, what] of rules) if (pattern.test(text)) findings.push(`${path}:${line}: ${what}`);
    const file = sourceTag.exec(text)?.[1];
    if (file && /\.(ts|tsx|mts)$/.test(file) && !/\b(symbol|region|lines)=/.test(text)) {
      findings.push(`${path}:${line}: <Source> shows all of ${file}; show the symbol it is about`);
    }
  }
  const lines = readFileSync(path, 'utf8').split('\n');
  let open;
  lines.forEach((text, i) => {
    if (!/^\s*(```|~~~)/.test(text)) return;
    if (open === undefined) open = i;
    else {
      const length = i - open - 1;
      if (length > longest && added.has(open + 1)) {
        findings.push(`${path}:${open + 1}: a ${length}-line code block; show an excerpt, or a <Source> symbol`);
      }
      open = undefined;
    }
  });
}
report('docs-prose', findings);
