// One JSON line per acceptance criterion in the triage brief, carrying the task, the criterion, the test that proves
// it and the change to src/, so a reviewer judges one criterion against the code without fetching anything.
import { findBrief, parseBrief } from './brief.mjs';
import { base, changeText } from './changes.mjs';

const maxChars = 24_000;

const text = findBrief();
if (text) {
  const { task, criteria } = parseBrief(text);
  const change = changeText(base(), ['src/'], 'function');
  const clipped = change.length > maxChars ? `${change.slice(0, maxChars)}\n[clipped]` : change;
  for (const { n, text: criterion, title, file } of criteria)
    console.log(JSON.stringify({ path: `criterion ${n}`, task, criterion, test: `it('${title}') in ${file}`, change: clipped }));
}
