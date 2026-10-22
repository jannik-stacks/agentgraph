import { execFileSync, spawnSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

export const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `agentgraph-${prefix}-`));

/** Runs git in `cwd` with a fixed identity and no signing. */
export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

/** Writes `files` under `root`, creating their directories. */
export const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

/** Commits `files` on the current branch and returns the commit id. */
export const commit = (cwd: string, files: Record<string, string>) => {
  write(cwd, files);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'c');
  return git(cwd, 'rev-parse', 'HEAD');
};

/** A repository with `before` committed as the base, then `after` written on top without committing and `remove` deleted. */
export const change = (before: Record<string, string>, after: Record<string, string> = {}, remove: string[] = []) => {
  const dir = temp('change');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { '.gitignore': 'node_modules/\n', ...before });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, after);
  for (const path of remove) rmSync(join(dir, path));
  return { dir, base };
};

/** Runs a hub script with node in `dir`, with `AGENTGRAPH_BASE` set to `base`; `env` extends `PATH`, `HOME` and the base. */
export const runScript = (
  path: string,
  { dir, base }: { dir: string; base?: string },
  args: string[] = [],
  env: Record<string, string> = {}
) => {
  const result = spawnSync(process.execPath, [path, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH ?? '',
      HOME: tmpdir(),
      TMPDIR: tmpdir(),
      ...(base && { AGENTGRAPH_BASE: base }),
      ...env,
    },
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};
