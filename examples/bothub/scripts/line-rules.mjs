// Pattern rules over the lines a change adds, or over every tracked line with `--all`.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { addedLines, base, changedFiles, report } from './changes.mjs';

const changed = () => {
  if (process.argv.includes('--all')) {
    const tracked = execFileSync('git', ['ls-files', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8' });
    return tracked
      .split('\n')
      .filter(path => path && existsSync(path))
      .map(path => ({ path, lines: () => readFileSync(path, 'utf8').split('\n').map((text, i) => ({ line: i + 1, text })) }));
  }
  const sha = base();
  return changedFiles(sha)
    .filter(({ deleted }) => !deleted)
    .map(({ path }) => ({ path, lines: () => addedLines(sha, path) }));
};

/**
 * Reports every added line of a file `wanted` keeps that matches a rule. A rule is `[pattern, message, applies?]`,
 * where `applies(path, text)` narrows it further.
 */
export const scan = (name, wanted, rules) => {
  const findings = [];
  for (const { path, lines } of changed()) {
    if (!wanted(path)) continue;
    for (const { line, text } of lines()) {
      for (const [pattern, message, applies] of rules) {
        if (pattern.test(text) && (!applies || applies(path, text))) findings.push(`${path}:${line}: ${message}`);
      }
    }
  }
  report(name, findings);
};
