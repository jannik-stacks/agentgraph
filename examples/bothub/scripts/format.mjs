// Checks the files a change touches under the formatted roots with oxfmt and the repository's own .oxfmtrc.json,
// the same roots `npm run verify` formats. On failure it prints the command that fixes them.
import { execFileSync } from 'node:child_process';
import { base, changedFiles, report } from './changes.mjs';

const formatted = /^(src|tests|bin|studio)\/.*\.(ts|tsx|mts|cts|js|mjs|json|css)$/;
const files = changedFiles(base())
  .filter(({ path, deleted }) => !deleted && formatted.test(path) && !path.startsWith('tests/fixtures/'))
  .map(({ path }) => path);

const findings = [];
if (files.length) {
  try {
    execFileSync('oxfmt', ['--check', ...files], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('oxfmt is not installed in this sandbox');
    findings.push(
      `files are not formatted:\n${`${e.stdout ?? ''}${e.stderr ?? ''}`.trim()}\n` +
        `Format them from the repository root with:\noxfmt ${files.join(' ')}`
    );
  }
}
report('format', findings);
