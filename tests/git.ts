import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

export const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `bothub-${prefix}-`));

/** Runs git in `cwd` with a fixed identity and no signing. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** Commits `files` on the current branch and returns the commit id. */
export const commit = (cwd: string, files: Record<string, string>) => {
  for (const [name, content] of Object.entries(files)) writeFileSync(join(cwd, name), content);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'c');
  return git(cwd, 'rev-parse', 'HEAD');
};

/** A local repository on `main` with one commit, plus a `feature` branch one commit ahead. */
export const sourceRepo = () => {
  const dir = temp('origin');
  git(dir, 'init', '-q', '-b', 'main');
  const main = commit(dir, { 'README.md': 'main\n' });
  git(dir, 'checkout', '-qb', 'feature');
  const feature = commit(dir, { 'feature.txt': 'feature\n' });
  git(dir, 'checkout', '-q', 'main');
  return { dir, main, feature };
};
