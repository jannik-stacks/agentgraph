// One JSON line per acceptance criterion in the triage brief, carrying the task, the criterion, the test that proves
// it with its code, the change to the src/, studio/src/ and hub script files that test imports (the whole change when
// they cannot be resolved) and the brief's out-of-scope list, so a reviewer judges one criterion against the code
// without fetching anything, and a criterion whose files did not change keeps its earlier verdict.
import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
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

const roots = ['src/', 'studio/src/', 'examples/bothub/scripts/'];
const imports = /^\s*(?:import|export)\b[^'"]*?['"](\.[^'"]+)['"]/gm;

/** The files under `roots` that `file` imports, following their own imports, or nothing when one cannot be read. */
const sourcesOf = file => {
  const seen = new Set();
  const visit = path => {
    let code;
    try {
      code = readFileSync(path, 'utf8');
    } catch {
      return false;
    }
    for (const [, spec] of code.matchAll(imports)) {
      const target = join(dirname(path), spec);
      if (seen.has(target) || !roots.some(root => target.startsWith(root))) continue;
      seen.add(target);
      if (!visit(target)) return false;
    }
    return true;
  };
  return visit(file) && seen.size ? [...seen] : undefined;
};

const clip = change => (change.length > maxChars ? `${change.slice(0, maxChars)}\n[clipped]` : change);

const text = findBrief();
if (text) {
  const { task, criteria, outOfScope } = parseBrief(text);
  const sha = base();
  for (const { n, text: criterion, title, file } of criteria) {
    const code = testCode(file, title);
    console.log(
      JSON.stringify({
        path: `criterion ${n}`,
        task,
        criterion,
        test: `it('${title}') in ${file}`,
        ...(code && { 'test code': code }),
        change: clip(changeText(sha, sourcesOf(file) ?? roots, 'function')),
        ...(outOfScope.length && { 'out of scope': outOfScope }),
      })
    );
  }
}
