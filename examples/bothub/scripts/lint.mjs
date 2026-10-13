// Runs oxlint with the repository's own .oxlintrc.json, plus the suspicious category, on the code files a change
// touches, and keeps only the errors on lines the change adds: code that was already there is not this change's to
// fix. The sandbox image ships the same oxlint version bothub locks.
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { relative, resolve } from 'node:path';
import { addedLines, base, changedFiles, report } from './changes.mjs';

const stricter = ['-D', 'suspicious', '-A', 'no-shadow', '-A', 'no-underscore-dangle'];

const code = /\.(ts|tsx|mts|cts|js|mjs)$/;
const sha = base();
const files = changedFiles(sha)
  .filter(({ path, deleted }) => !deleted && code.test(path) && !/^(tests\/fixtures|examples|research)\//.test(path))
  .map(({ path }) => path);

const lint = () => {
  const config = existsSync('.oxlintrc.json') ? ['-c', '.oxlintrc.json'] : [];
  try {
    return execFileSync('oxlint', [...config, ...stricter, '--format', 'json', ...files], {
      encoding: 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      maxBuffer: 64 * 1024 * 1024,
    });
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error('oxlint is not installed in this sandbox');
    return e.stdout ?? '';
  }
};

const findings = [];
if (files.length) {
  const out = lint();
  let diagnostics;
  try {
    diagnostics = JSON.parse(out).diagnostics;
  } catch {
    findings.push(`oxlint gave no readable result:\n${out.trim()}`);
  }
  const added = new Map(files.map(path => [path, new Set(addedLines(sha, path).map(({ line }) => line))]));
  for (const { severity, code: rule, message, filename, labels } of diagnostics ?? []) {
    const path = relative(process.cwd(), resolve(filename));
    const line = labels?.[0]?.span.line;
    if (severity !== 'error' || !added.get(path)?.has(line)) continue;
    findings.push(`${path}:${line}: ${rule}: ${message}`);
  }
}
report('lint', findings);
