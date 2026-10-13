import { execFileSync, spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import type { AgentEvent, HarnessAdapter, RunSpec } from '../src/types.ts';

export const temp = (prefix: string) => mkdtempSync(join(tmpdir(), `bothub-${prefix}-`));

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

let template: { dir: string; main: string; feature: string } | undefined;

/** A local repository on `main` with one commit, plus a `feature` branch one commit ahead. */
export const sourceRepo = () => {
  if (!template) {
    const dir = temp('template');
    git(dir, 'init', '-q', '-b', 'main');
    const main = commit(dir, { 'README.md': 'main\n' });
    git(dir, 'checkout', '-qb', 'feature');
    const feature = commit(dir, { 'feature.txt': 'feature\n' });
    git(dir, 'checkout', '-q', 'main');
    template = { dir, main, feature };
  }
  const dir = temp('origin');
  cpSync(template.dir, dir, { recursive: true });
  return { ...template, dir };
};

/** A bare clone of `dir`, a fresh {@link sourceRepo} unless given, to serve as a local origin. */
export const bareOrigin = (dir = sourceRepo().dir) => {
  const bare = join(temp('bare'), 'app.git');
  git(dir, 'clone', '-q', '--bare', dir, bare);
  return bare;
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

/** Runs a hub script with node in `dir`, with `BOTHUB_BASE` set to `base`; `env` extends `PATH`, `HOME` and the base. */
export const runScript = (
  path: string,
  { dir, base }: { dir: string; base?: string },
  args: string[] = [],
  env: Record<string, string> = {}
) => {
  const result = spawnSync(process.execPath, [path, ...args], {
    cwd: dir,
    encoding: 'utf8',
    env: { PATH: process.env.PATH ?? '', HOME: tmpdir(), TMPDIR: tmpdir(), ...(base && { BOTHUB_BASE: base }), ...env },
  });
  return { ok: result.status === 0, out: `${result.stdout}${result.stderr}`.trim() };
};

type Behaviour = { events: AgentEvent[]; work?: string; exit?: number };

/**
 * A harness that runs `node -e` in the worktree: `work` first, then it prints `events` and exits with `exit`. Records
 * each spec in `seen`; `adapters` holds it under both harness names.
 */
export const fakeHarness = (behave: (spec: RunSpec, call: number) => Behaviour) => {
  const seen: RunSpec[] = [];
  const adapter: HarnessAdapter = {
    name: 'opencode',
    command: spec => {
      seen.push(spec);
      const { events, work = '', exit = 0 } = behave(spec, seen.length);
      const out = events.map(event => JSON.stringify(event)).join('\n');
      const script = `const fs = require('fs'); ${work}; console.log(${JSON.stringify(out)}); process.exit(${exit})`;
      return { cmd: process.execPath, args: ['-e', script], env: {} };
    },
    parseLine: line => (line.trim() ? [JSON.parse(line) as AgentEvent] : []),
  };
  return { seen, adapters: { opencode: adapter, pi: { ...adapter, name: 'pi' as const } } };
};
