// Lints and format-checks the code a change touches. oxlint runs with the repository's .oxlintrc.json, or the graph's
// oxlintrc.json when the repository has none, plus the suspicious category; only errors on lines the change adds
// fail, lines that only make its rename aside, since code that was already there is not this change's to fix.
// Warnings on added lines are printed. oxfmt checks every changed file when the repository has its own
// .oxfmtrc.json, and otherwise only new code files, against the graph's oxfmtrc.json. The sandbox image ships the oxlint
// and oxfmt versions agentgraph locks.
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { readBaseShaFromEnv, changedFiles, inBase, ownLines, report } from './changes.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const stricter = ['-D', 'suspicious', '-A', 'no-shadow', '-A', 'no-underscore-dangle'];
const code = /\.(ts|tsx|mts|cts|js|mjs)$/;
const styled = /\.(ts|tsx|mts|cts|js|mjs|json|css)$/;
const skipped = /^(tests\/fixtures|examples|research)\/|(^|\/)package-lock\.json$/;

const sha = readBaseShaFromEnv();
const changed = changedFiles(sha).filter(({ path, deleted }) => !deleted && !skipped.test(path));
const linted = changed.filter(({ path }) => code.test(path)).map(({ path }) => path);
const ownFormat = existsSync('.oxfmtrc.json');
const formatted = changed
  .filter(({ path }) => (ownFormat ? styled.test(path) : code.test(path) && !inBase(sha, path)))
  .map(({ path }) => path);

const run = (cmd, args) => {
  try {
    return { ok: true, out: execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 64 * 1024 * 1024 }) };
  } catch (e) {
    if (e.code === 'ENOENT') throw new Error(`${cmd} is not installed in this sandbox`);
    return { ok: false, out: `${e.stdout ?? ''}${e.stderr ?? ''}`, stdout: e.stdout ?? '' };
  }
};

const config = (own, graph) => (existsSync(own) ? ['-c', own] : existsSync(join(here, graph)) ? ['-c', join(here, graph)] : []);

const findings = [];
if (linted.length) {
  const result = run('oxlint', [...config('.oxlintrc.json', 'oxlintrc.json'), ...stricter, '--format', 'json', ...linted]);
  let diagnostics;
  try {
    diagnostics = JSON.parse(result.ok ? result.out : result.stdout).diagnostics;
  } catch {
    findings.push(`oxlint gave no readable result:\n${result.out.trim()}`);
  }
  const added = new Map(linted.map(path => [path, new Set(ownLines(sha, path).map(({ line }) => line))]));
  for (const { severity, code: rule, message, filename, labels } of diagnostics ?? []) {
    const path = relative(process.cwd(), resolve(filename));
    const line = labels?.[0]?.span.line;
    if (!added.get(path)?.has(line)) continue;
    if (severity === 'error') findings.push(`${path}:${line}: ${rule}: ${message}`);
    else console.log(`${path}:${line}: warning ${rule}: ${message}`);
  }
}
if (formatted.length) {
  const format = run('oxfmt', [...(ownFormat ? [] : config('.oxfmtrc.json', 'oxfmtrc.json')), '--check', ...formatted]);
  if (!format.ok) {
    const fix =
      ownFormat || !existsSync(join(here, 'oxfmtrc.json'))
        ? `oxfmt ${formatted.join(' ')}`
      : `printf '%s' '${JSON.stringify(JSON.parse(readFileSync(join(here, 'oxfmtrc.json'), 'utf8')))}' > /tmp/oxfmtrc.json && oxfmt --config /tmp/oxfmtrc.json ${formatted.join(' ')}`;
    findings.push(`files are not formatted:\n${format.out.trim()}\nFormat them from the repository root with:\n${fix}`);
  }
}
report('lint', findings);
