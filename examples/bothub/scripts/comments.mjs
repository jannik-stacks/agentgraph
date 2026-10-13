// Code comments a change adds read as if the code was always this way: no dates, rulings, names or history, and the
// project's vocabulary.
import { extname } from 'node:path';
import { addedLines, base, changedFiles, report } from './changes.mjs';

const rules = [
  [/\b20\d\d-\d\d-\d\d\b/, 'a date'],
  [/\b(decision|record|ruling)\s+#?\d{2,4}\b|\bruled\b|\bruling\b/i, 'a ruling or decision reference'],
  [/\bMorgan\b/, 'a name'],
  [/\b(renamed (from|to)|formerly|previously called|used to be|no longer)\b/i, 'history'],
  [/[·⊃⊂∘‖≡⇄↔]/, 'a middle dot or math symbol'],
  [/\binert\b/i, 'the word "inert"'],
  [/\bexecutors?\b/i, 'the word "executor"; say "harness"'],
];

const code = new Set(['.ts', '.tsx', '.mts', '.cts', '.js', '.mjs']);
const comment = /^\s*(\/\/|\/\*|\*)|\s\/\/\s/;

const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !code.has(extname(path)) || path.startsWith('tests/fixtures/')) continue;
  for (const { line, text } of addedLines(sha, path)) {
    if (!comment.test(text)) continue;
    const body = text.slice(text.search(/\/\/|\/\*|\*/));
    for (const [pattern, what] of rules) if (pattern.test(body)) findings.push(`${path}:${line}: ${what} in a comment`);
  }
}
report('comments', findings);
