// One JSON line per acceptance criterion in the triage brief, carrying the task, the criterion, the test that proves
// it with its code and the change to src/ and studio/src/, so a reviewer judges one criterion against the code without
// fetching anything.
import { readFileSync } from 'node:fs';
import { findBrief, parseBrief } from './brief.mjs';
import { base, changeText, titleOf } from './changes.mjs';

const maxChars = 24_000;
const maxTestLines = 80;

const depth = line =>
  line
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
    .replace(/\/\/.*$/, '')
    .split('')
    .reduce((n, ch) => n + (ch === '(' ? 1 : ch === ')' ? -1 : 0), 0);

/** The `it` or `test` call titled `title` in `file` as it reads now, or nothing when there is no such test yet. */
const testCode = (file, title) => {
  let lines;
  try {
    lines = readFileSync(file, 'utf8').split('\n');
  } catch {
    return;
  }
  const start = lines.findIndex(line => titleOf(line) === title);
  if (start < 0) return;
  let open = 0;
  for (let i = start; i < Math.min(lines.length, start + maxTestLines); i++) {
    open += depth(lines[i]);
    if (open <= 0) return lines.slice(start, i + 1).join('\n');
  }
  return [...lines.slice(start, start + maxTestLines), '[clipped]'].join('\n');
};

const text = findBrief();
if (text) {
  const { task, criteria } = parseBrief(text);
  const change = changeText(base(), ['src/', 'studio/src/'], 'function');
  const clipped = change.length > maxChars ? `${change.slice(0, maxChars)}\n[clipped]` : change;
  for (const { n, text: criterion, title, file } of criteria) {
    const code = testCode(file, title);
    console.log(
      JSON.stringify({
        path: `criterion ${n}`,
        task,
        criterion,
        test: `it('${title}') in ${file}`,
        ...(code && { 'test code': code }),
        change: clipped,
      })
    );
  }
}
