// Guards the test suite a change leaves behind, cheapest first. Against $BOTHUB_BASE it keeps every test with its
// assertions, skips, focuses and slows none, and leaves tests/setup/ alone. The test lines it adds assert outside
// loops and branches, so each case is its own it.each row. It adds the test each criterion of the
// triage brief names, with its exact title, in the file the criterion names. And every test it adds fails on the
// base code: in a temporary copy of the base with the change's tests/ files on top, a new test that passes would not
// notice the change being reverted. A test titled "still …" guards behavior that already worked and may pass.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findBrief, parseBrief } from './brief.mjs';
import { addedLines, base, baseText, changedFiles, isTestFile, report } from './changes.mjs';

const call = /\b(it|test)(\.each\([^)]*\))?\(\s*(['"`])(.+?)\3/;
const titleOf = text => call.exec(text)?.[4];

const count = (text, pattern) => text.match(pattern)?.length ?? 0;
const testCalls = /\b(it|test)(\.each\([^)]*\))?\(/g;
const expectCalls = /\bexpect(\.soft)?\(/g;
const skipped = [
  [/\b(it|test|describe)\.(skip|only|todo)\b/, 'an added .skip, .only or .todo'],
  [/\bx(it|describe|test)\(/, 'an added xit or xdescribe'],
  [/\.(skipIf|runIf)\(\s*(true|false|!?[01])\s*\)/, 'a test skipped by a constant condition'],
];
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
const changed = changedFiles(sha);
const findings = [];

const integrity = () => {
  for (const { path, deleted } of changed) {
    if (!path.startsWith('tests/')) continue;
    if (path.startsWith('tests/setup/')) findings.push(`${path}: edits the global test setup`);
    if (!isTestFile(path)) continue;
    const before = baseText(sha, path);
    if (deleted) {
      if (before !== undefined) findings.push(`${path}: deletes a test file with ${count(before, testCalls)} tests`);
      continue;
    }
    const after = readFileSync(path, 'utf8');
    if (before !== undefined) {
      const [was, is] = [count(before, testCalls), count(after, testCalls)];
      if (is < was) findings.push(`${path}: ${was - is} fewer tests than the base (${was} to ${is})`);
      const [had, has] = [count(before, expectCalls), count(after, expectCalls)];
      if (has < had) findings.push(`${path}: ${had - has} fewer expect( calls than the base (${had} to ${has})`);
    }
    for (const { line, text: raw } of addedLines(sha, path)) {
      const text = raw.replace(strings, '""');
      for (const [pattern, what] of skipped) if (pattern.test(text)) findings.push(`${path}:${line}: ${what}`);
      const ms = timeoutOf(text);
      if (ms > defaultTimeout) findings.push(`${path}:${line}: a test timeout of ${ms} ms, above the ${defaultTimeout} ms default`);
    }
  }
};

const loopOpen = /^for(\s+await)?\s*\(|\.forEach\(/;
const branchOpen = /^(\}\s*)?(if\s*\(|else\b)/;
const asserts = /\bexpect(\.soft)?\(/;

/** Loops and branches that hold an `expect(`, found by indentation in formatted code, with line numbers from 1. */
const shapeOf = text => {
  const found = [];
  const open = [];
  const close = () => {
    const block = open.pop();
    if (block.kind !== 'loop') return;
    const outer = open.findLast(b => b.kind === 'loop');
    if (outer) outer.inner.push(block.line, ...block.inner);
    else if (block.asserts)
      found.push({ line: block.line, what: 'loop' }, ...block.inner.map(line => ({ line, what: 'nested' })));
  };
  text.split('\n').forEach((raw, i) => {
    const row = raw.replace(strings, '""');
    const trimmed = row.trim();
    if (!trimmed || trimmed.startsWith('//')) return;
    const indent = row.length - row.trimStart().length;
    const closing = /^[\]})]/.test(trimmed);
    while (open.length && (indent < open.at(-1).indent || (indent === open.at(-1).indent && !closing))) close();
    if (trimmed.startsWith('}') && open.at(-1)?.indent === indent) close();
    const line = i + 1;
    const kind = loopOpen.test(trimmed) ? 'loop' : branchOpen.test(trimmed) ? 'branch' : undefined;
    if (kind) open.push({ kind, indent, line, asserts: false, inner: [] });
    if (!asserts.test(trimmed)) return;
    for (const block of open) block.asserts = true;
    if (open.some(b => b.kind === 'branch')) found.push({ line, what: 'branch' });
  });
  while (open.length) close();
  return found.sort((a, b) => a.line - b.line);
};

const shapeText = {
  loop: 'a loop of expect( calls inside a test; give each case an it.each row from an upcased const array, or collect the results and assert once after the loop',
  nested: 'a loop nested in a loop of expect( calls; flatten the cases into one it.each table',
  branch: 'an expect( under an if or else; give each case its own test that asserts unconditionally',
};

const shape = () => {
  for (const { path, deleted } of changed) {
    if (deleted || !isTestFile(path)) continue;
    const added = new Set(addedLines(sha, path).map(({ line }) => line));
    for (const { line, what } of shapeOf(readFileSync(path, 'utf8')))
      if (added.has(line)) findings.push(`${path}:${line}: ${shapeText[what]}`);
  }
};

const criteria = () => {
  const brief = findBrief();
  if (!brief) {
    console.log('test-guards: no triage brief found for this run, so no criterion tests to look for');
    return;
  }
  const files = new Set(changed.filter(f => !f.deleted).map(f => f.path));
  const lines = (file, all) => {
    if (!all) return files.has(file) ? addedLines(sha, file).map(({ text }) => text) : [];
    try {
      return readFileSync(file, 'utf8').split('\n');
    } catch {
      return [];
    }
  };
  for (const { n, title, file } of parseBrief(brief).criteria) {
    const still = title.startsWith('still ');
    if (!lines(file, still).some(line => titleOf(line) === title))
      findings.push(`criterion ${n}: no test titled '${title}' ${still ? 'in' : 'added in'} ${file}; add it with that exact title`);
  }
};

const bite = () => {
  const tests = changed.filter(f => !f.deleted && isTestFile(f.path)).map(f => f.path);
  const added = new Map(
    tests.map(path => [
      path,
      addedLines(sha, path).flatMap(({ line, text }) => {
        const title = titleOf(text);
        return title && !title.includes('${') ? [{ line, title }] : [];
      }),
    ])
  );
  const fresh = [...added].filter(([, titles]) => titles.length).map(([path]) => path);
  if (!changed.some(f => !f.path.startsWith('tests/')) || !fresh.length) return;
  const tmp = mkdtempSync(join(tmpdir(), 'bothub-test-guards-'));
  try {
    const tree = join(tmp, 'tree');
    mkdirSync(tree);
    execFileSync('git', ['archive', '--format=tar', '-o', join(tmp, 'base.tar'), `${sha}:./`]);
    execFileSync('tar', ['-xf', join(tmp, 'base.tar'), '-C', tree]);
    for (const { path, deleted } of changed.filter(f => f.path.startsWith('tests/'))) {
      if (deleted) rmSync(join(tree, path), { force: true });
      else {
        mkdirSync(dirname(join(tree, path)), { recursive: true });
        cpSync(path, join(tree, path));
      }
    }
    if (existsSync('node_modules')) symlinkSync(realpathSync('node_modules'), join(tree, 'node_modules'));
    const out = join(tmp, 'result.json');
    const run = spawnSync(
      join(tree, 'node_modules/.bin/vitest'),
      ['run', ...fresh, '--reporter=json', `--outputFile=${out}`, '--includeTaskLocation', '--coverage.enabled=false'],
      { cwd: tree, encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, HOME: process.env.HOME || tmp } }
    );
    if (!existsSync(out)) throw new Error(`vitest did not run on the base code:\n${`${run.stdout}${run.stderr}`.trim()}`);
    const results = JSON.parse(readFileSync(out, 'utf8')).testResults;
    for (const path of fresh) {
      const file = results.find(r => realpathSync(r.name) === realpathSync(join(tree, path)));
      for (const { line, title } of added.get(path)) {
        if (title.startsWith('still ')) continue;
        if (file?.assertionResults.find(a => a.title === title)?.status === 'passed')
          findings.push(`${path}:${line}: '${title}' passes on the base code, so it would not catch the change being reverted`);
      }
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
};

integrity();
shape();
criteria();
bite();
report('test-guards', findings);
