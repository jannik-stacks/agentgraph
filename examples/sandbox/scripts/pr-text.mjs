import { readFileSync } from 'node:fs';

const proposals = JSON.parse(readFileSync(process.env.BOTHUB_PROPOSALS, 'utf8'));

const body = [
  [/\b\d+ (?:\w+ )?tests?\b|\ball (?:the )?(?:\w+ )?tests? pass/i, 'counts passing tests'],
  [/\bpass(?:es|ed|ing)?\b/i, 'says what passed'],
  [/\b(?:no|not|never)\b[^.\n]*\b(?:run|ran)\b/i, 'lists a step that was not run'],
  [/human review and merge required|nothing left open/i, 'is boilerplate'],
];
const conventional = /^(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\([^)]+\))?!?: \S/;

const hits = [];
for (const p of proposals) {
  if (p.kind === 'pull_request')
    for (const [re, why] of body) {
      const found = re.exec(p.body);
      if (found) hits.push(`pull request body ${why}: "${found[0]}"`);
    }
  if (p.kind === 'push') {
    const [subject, ...rest] = p.message.split('\n');
    if (!conventional.test(subject)) hits.push(`commit subject is not a conventional commit: "${subject}"`);
    if (subject.length > 72) hits.push(`commit subject is ${subject.length} characters, over 72`);
    const lines = rest.filter(line => line.trim()).length;
    if (lines > 3) hits.push(`commit body is ${lines} lines, over 3`);
  }
}
if (hits.length) console.log(hits.join('\n'));
process.exit(hits.length ? 1 : 0);
