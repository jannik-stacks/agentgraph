// The whole change to src/ with each changed function in full, after the task and criteria from the triage brief:
// what a reviewer needs to follow one piece of state through every path that touches it. Prints nothing when src/
// did not change.
import { findBrief, parseBrief } from './brief.mjs';
import { base, changeText } from './changes.mjs';

const change = changeText(base(), ['src/'], 'function');
const brief = change && findBrief();
if (brief) {
  const { task, criteria } = parseBrief(brief);
  console.log(`Task: ${task}\n\nCriteria:\n${criteria.map(c => `${c.n}. ${c.text}`).join('\n')}\n`);
}
if (change) console.log(change);
