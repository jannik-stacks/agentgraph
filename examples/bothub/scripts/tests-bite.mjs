// New tests must fail on the base code: in a temporary copy of $BOTHUB_BASE with the change's tests/ files on top,
// each test the change adds runs and must fail. A new test that passes there would not notice the change reverted.
// A test whose title starts with "still " guards behavior that already worked, so it may pass.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { addedLines, base, changedFiles, isTestFile, report } from './changes.mjs';

const call = /\b(it|test)\(\s*(['"`])(.+?)\2/;

const sha = base();
const changed = changedFiles(sha);
const tests = changed.filter(f => !f.deleted && isTestFile(f.path)).map(f => f.path);
const added = new Map(
  tests.map(path => [
    path,
    addedLines(sha, path).flatMap(({ line, text }) => {
      const title = call.exec(text)?.[3];
      return title && !title.includes('${') ? [{ line, title }] : [];
    }),
  ])
);
const fresh = [...added].filter(([, titles]) => titles.length).map(([path]) => path);

if (!changed.some(f => !f.path.startsWith('tests/'))) console.log('tests-bite: the change is only tests; nothing to bite');
else if (!fresh.length) console.log('tests-bite: no new tests');
else {
  const tmp = mkdtempSync(join(tmpdir(), 'bothub-tests-bite-'));
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
    const findings = [];
    for (const path of fresh) {
      const file = results.find(r => realpathSync(r.name) === realpathSync(join(tree, path)));
      for (const { line, title } of added.get(path)) {
        if (title.startsWith('still ')) continue;
        const test = file?.assertionResults.find(a => a.title === title);
        if (test?.status === 'passed')
          findings.push(
            `${path}:${line}: '${title}' passes on the base code, so it would not catch the change being reverted`
          );
      }
    }
    report('tests-bite', findings);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
