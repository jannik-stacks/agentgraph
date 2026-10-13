// Runs oxlint with the repository's own .oxlintrc.json on the code files a change touches. The sandbox image ships
// the same oxlint version bothub locks.
import { execFileSync } from 'node:child_process';
import { base, changedFiles, report } from './changes.mjs';

const code = /\.(ts|tsx|mts|cts|js|mjs)$/;
const files = changedFiles(base())
  .filter(({ path, deleted }) => !deleted && code.test(path) && !/^(tests\/fixtures|examples|research)\//.test(path))
  .map(({ path }) => path);

const findings = [];
if (files.length) {
  try {
    const out = execFileSync('oxlint', files, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
    if (!/Found 0 warnings/.test(out)) console.log(out.trim());
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('oxlint is not installed in this sandbox');
    findings.push(`oxlint found errors:\n${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim()}`);
  }
}
report('lint', findings);
