// Runs the tests related to the changed source files with coverage and fails a failing test and every added line that
// no test runs, except lines that only make the change's rename. The repository's whole-file thresholds are left
// out: the related tests alone never reach them, and code the change did not write is not its to cover. Reports go to
// a temporary directory, never the worktree.
//
//   node coverage.mjs <root>...      e.g. node coverage.mjs src/
import { spawnSync } from 'node:child_process';
import { existsSync, mkdtempSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ownLines, base, changedFiles, report } from './changes.mjs';

const roots = process.argv.slice(2);
if (!roots.length) throw new Error('usage: coverage.mjs <root>...');

const code = /\.(ts|mts|js|mjs)$/;
const sha = base();
const files = changedFiles(sha)
  .filter(({ path, deleted }) => !deleted && code.test(path) && roots.some(root => path.startsWith(root)))
  .map(({ path }) => path);

/** For each line, the fewest times any statement starting on it ran: 0 when part of the line never ran. */
const lineHits = ({ statementMap, s }) => {
  const hits = new Map();
  for (const [id, { start }] of Object.entries(statementMap))
    hits.set(start.line, Math.min(hits.get(start.line) ?? Infinity, s[id]));
  return hits;
};

/** Consecutive line numbers folded into ranges. */
const ranges = lines =>
  lines.reduce((all, line) => {
    const last = all.at(-1);
    if (last && line === last[1] + 1) last[1] = line;
    else all.push([line, line]);
    return all;
  }, []);

if (!files.length) console.log('coverage: no changed source files');
else {
  const tmp = mkdtempSync(join(tmpdir(), 'agentgraph-coverage-'));
  try {
    const run = spawnSync(
      'node_modules/.bin/vitest',
      [
        'related',
        ...files,
        '--run',
        '--reporter=dot',
        '--reporter=json',
        `--outputFile.json=${join(tmp, 'tests.json')}`,
        '--coverage.enabled=true',
        '--coverage.reporter=json',
        `--coverage.reportsDirectory=${join(tmp, 'coverage')}`,
        ...files.map(file => `--coverage.include=${file}`),
      ],
      { encoding: 'utf8', timeout: 10 * 60_000, env: { ...process.env, HOME: process.env.HOME || tmp } }
    );
    const findings = [];
    const tests = join(tmp, 'tests.json');
    const result = existsSync(tests) ? JSON.parse(readFileSync(tests, 'utf8')) : undefined;
    const testsFailed = !result || result.numFailedTests > 0 || result.numFailedTestSuites > 0;
    if (run.status !== 0 && testsFailed)
      findings.push(`the related tests failed:\n${`${run.stdout}${run.stderr}`.trim().split('\n').slice(-30).join('\n')}`);
    const json = join(tmp, 'coverage', 'coverage-final.json');
    const coverage = existsSync(json) ? JSON.parse(readFileSync(json, 'utf8')) : {};
    const byPath = new Map(Object.entries(coverage).map(([path, data]) => [realpathSync(path), data]));
    for (const file of files) {
      const data = byPath.get(realpathSync(file));
      if (!data) continue;
      const hits = lineHits(data);
      const missed = ownLines(sha, file)
        .map(({ line }) => line)
        .filter(line => hits.get(line) === 0);
      for (const [from, to] of ranges(missed))
        findings.push(`${file}:${from === to ? from : `${from}-${to}`}: added code no test runs`);
    }
    report('coverage', findings);
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
}
