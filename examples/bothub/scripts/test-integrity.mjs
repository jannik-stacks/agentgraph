// Fails a change that weakens the test suite compared with $BOTHUB_BASE: a deleted test file, fewer tests or
// expect( calls in a file, an added .skip, .only or .todo, a test timeout raised above the default, or an edit to
// the global setup under tests/setup/.
import { readFileSync } from 'node:fs';
import { addedLines, base, baseText, changedFiles, isTestFile, report } from './changes.mjs';

const count = (text, pattern) => text.match(pattern)?.length ?? 0;
const testCall = /\b(it|test)(\.each\([^)]*\))?\(/g;
const expectCall = /\bexpect(\.soft)?\(/g;

const skipped = [
  [/\b(it|test|describe)\.(skip|only|todo)\b/, 'an added .skip, .only or .todo'],
  [/\bx(it|describe|test)\(/, 'an added xit or xdescribe'],
  [/\.(skipIf|runIf)\(\s*(true|false|!?[01])\s*\)/, 'a test skipped by a constant condition'],
];
// Test code quoted inside a string, as fixtures for checks like this one write it, is not a test.
const strings = /'(?:[^'\\]|\\.)*'|"(?:[^"\\]|\\.)*"|`(?:[^`\\]|\\.)*`/g;
const defaultTimeout = 5000;
const timeouts = [
  /\b(test|hook|teardown)Timeout\s*[:=(,]\s*([\d_]+)/,
  /\b(it|test|describe)(\.\w+)?\(\s*(['"`]).*?\3\s*,\s*\{[^}]*\btimeout:\s*([\d_]+)/,
  /^\s*\}\s*,\s*([\d_]+)\s*\)\s*;?\s*$/,
];
const timeoutOf = text => {
  for (const pattern of timeouts) {
    const m = pattern.exec(text);
    if (m) return Number(m[m.length - 1].replaceAll('_', ''));
  }
};

const sha = base();
const findings = [];
for (const { path, deleted } of changedFiles(sha)) {
  if (!path.startsWith('tests/')) continue;
  if (path.startsWith('tests/setup/')) findings.push(`${path}: edits the global test setup`);
  if (!isTestFile(path)) continue;
  const before = baseText(sha, path);
  if (deleted) {
    if (before !== undefined) findings.push(`${path}: deletes a test file with ${count(before, testCall)} tests`);
    continue;
  }
  const after = readFileSync(path, 'utf8');
  if (before !== undefined) {
    const [was, is] = [count(before, testCall), count(after, testCall)];
    if (is < was) findings.push(`${path}: ${was - is} fewer tests than the base (${was} to ${is})`);
    const [had, has] = [count(before, expectCall), count(after, expectCall)];
    if (has < had) findings.push(`${path}: ${had - has} fewer expect( calls than the base (${had} to ${has})`);
  }
  for (const { line, text: raw } of addedLines(sha, path)) {
    const text = raw.replace(strings, '""');
    for (const [pattern, what] of skipped) if (pattern.test(text)) findings.push(`${path}:${line}: ${what}`);
    const ms = timeoutOf(text);
    if (ms > defaultTimeout) findings.push(`${path}:${line}: a test timeout of ${ms} ms, above the ${defaultTimeout} ms default`);
  }
}
report('test-integrity', findings);
