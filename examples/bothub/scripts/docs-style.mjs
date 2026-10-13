// The written docs rules as a check on the lines a change adds to studio/content/docs: words instead of symbols,
// headings that are names, and the project's vocabulary.
import { addedLines, base, changedFiles, report } from './changes.mjs';

const rules = [
  [/·/, 'a middle dot separator; use a comma, "and" or an em dash'],
  [/[⊃⊂∘‖≡⇄↔]/, 'a math or logic symbol; write the words instead'],
  [/\binert\b/i, 'the word "inert"'],
  [/\bexecutors?\b/i, 'the word "executor"; say "harness"'],
  [/\b(centerpiece|honest(ly)?|game[- ]changer|seamless(ly)?|revolutionary)\b|\bthe real story\b/i, 'a marketing word'],
];

const heading = /^#{1,6}\s+(.*)$/;
const numbered = /^[A-Z]-\d+ — /;
const headingProblem = title => {
  if (numbered.test(title)) return;
  if (/ [—–] /.test(title)) return 'a heading with an em-dash suffix; a heading is a name';
  if (/^[^`]*\w: /.test(title) || /:\s*$/.test(title)) return 'a heading with a colon prefix or suffix';
};

const docs = /^studio\/content\/docs\/.*\.mdx?$/;
const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (deleted || !docs.test(path)) continue;
  let fenced = false;
  for (const { line, text } of addedLines(sha, path)) {
    if (/^\s*(```|~~~)/.test(text)) fenced = !fenced;
    if (fenced) continue;
    for (const [pattern, what] of rules) if (pattern.test(text)) findings.push(`${path}:${line}: ${what}`);
    const title = heading.exec(text)?.[1];
    const problem = title && headingProblem(title);
    if (problem) findings.push(`${path}:${line}: ${problem}`);
  }
}
report('docs-style', findings);
