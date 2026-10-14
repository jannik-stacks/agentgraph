// Runs the base's version of every test file the change edits against the change's code, in a temporary copy of the
// worktree, and names each old test that now fails. An old test edited to pass can hide a regression; one the issue
// changes on purpose is for the reviewer to tell apart by its title. Criterion tests of the triage brief are left out.
import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, existsSync, lstatSync, mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { findBrief, parseBrief } from './brief.mjs';
import { base, baseText, changedFiles, inBase, isTestFile, report } from './changes.mjs';

const line = text => (text ?? '').split('\n').find(Boolean)?.slice(0, 200) ?? '';

const sha = base();
const edited = changedFiles(sha)
  .filter(({ path, deleted }) => !deleted && isTestFile(path) && inBase(sha, path))
  .map(({ path }) => path);
const findings = [];

if (edited.length) {
  const brief = findBrief();
  const criteria = new Set(brief ? parseBrief(brief).criteria.map(c => c.title) : []);
  const tmp = mkdtempSync(join(tmpdir(), 'bothub-old-tests-'));
  try {
    const tree = join(tmp, 'tree');
    const files = execFileSync('git', ['ls-files', '-co', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
    for (const path of files.split('\n').filter(Boolean)) {
      if (!existsSync(path) || !lstatSync(path).isFile()) continue;
      mkdirSync(dirname(join(tree, path)), { recursive: true });
      cpSync(path, join(tree, path));
    }
    for (const path of edited) writeFileSync(join(tree, path), baseText(sha, path));
    if (existsSync('node_modules')) symlinkSync(realpathSync('node_modules'), join(tree, 'node_modules'));
    const out = join(tmp, 'result.json');
    const run = spawnSync(
      join(tree, 'node_modules/.bin/vitest'),
      ['run', ...edited, '--reporter=json', `--outputFile=${out}`, '--coverage.enabled=false'],
      { cwd: tree, encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, HOME: process.env.HOME || tmp } }
    );
    if (!existsSync(out)) throw new Error(`vitest did not run the base's tests:\n${`${run.stdout}${run.stderr}`.trim()}`);
    const results = JSON.parse(readFileSync(out, 'utf8')).testResults;
    for (const path of edited) {
      const file = results.find(r => realpathSync(r.name) === realpathSync(join(tree, path)));
      const failed = file?.assertionResults.filter(a => a.status === 'failed' && !criteria.has(a.title)) ?? [];
      if (file?.status === 'failed' && !file.assertionResults.some(a => a.status === 'failed'))
        findings.push(`${path}: the base's version no longer runs against the change: ${line(file.message)}`);
      for (const test of failed)
        findings.push(`${path}: the base's '${test.fullName}' fails against the change: ${line(test.failureMessages?.[0])}`);
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}

report('old-tests', findings);
