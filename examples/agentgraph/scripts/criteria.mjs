import { readFileSync } from 'node:fs';
import { basename } from 'node:path';
import { findBrief, parseBrief } from './brief.mjs';
import { readEnvBaseSha, changedFiles, changeText, parseTestCallTitle } from './changes.mjs';

const maxChars = 24_000;
const maxTestLines = 80;

const depth = line =>
  line
    .replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '')
    .replace(/\/\/.*$/, '')
    .split('')
    .reduce((n, ch) => n + (ch === '(' ? 1 : ch === ')' ? -1 : 0), 0);

const testCode = (lines, title) => {
  const start = lines.findIndex(line => parseTestCallTitle(line) === title);
  if (start < 0) return;
  let open = 0;
  for (let i = start; i < Math.min(lines.length, start + maxTestLines); i++) {
    open += depth(lines[i]);
    if (open <= 0) return lines.slice(start, i + 1).join('\n');
  }
  return [...lines.slice(start, start + maxTestLines), '[clipped]'].join('\n');
};

const roots = ['src/', 'studio/src/', 'examples/agentgraph/scripts/'];

const read = file => {
  try {
    return readFileSync(file, 'utf8');
  } catch {
    return '';
  }
};

const clip = change => (change.length > maxChars ? `${change.slice(0, maxChars)}\n[clipped]` : change);

const text = findBrief();
if (text) {
  const { task, criteria, excluded } = parseBrief(text);
  const sha = readEnvBaseSha();
  const changed = changedFiles(sha)
    .map(({ path }) => path)
    .filter(path => roots.some(root => path.startsWith(root)));
  for (const { n, text: criterion, title, file } of criteria) {
    const test = read(file);
    const code = testCode(test.split('\n'), title);
    const names = new Set(test.match(/[\w.-]+\.\w+/g));
    const own = changed.filter(path => names.has(basename(path)));
    console.log(
      JSON.stringify({
        path: `criterion ${n}`,
        task,
        criterion,
        ...(criteria.length > 1 && { 'other criteria': criteria.filter(c => c.n !== n).map(c => c.text) }),
        test: `it('${title}') in ${file}`,
        ...(code && { 'test code': code }),
        change: clip(changeText(sha, own.length ? own : roots, 'function')),
        ...(excluded.length && { 'out of scope': excluded }),
      })
    );
  }
}
