import { execFileSync, spawnSync } from 'node:child_process';
import { appendFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative } from 'node:path';
import { findIssueDir } from '../src/tracker.ts';
import type { RunRecord } from '../src/types.ts';

export const makeRun = (run: Partial<RunRecord> & Pick<RunRecord, 'id'>): RunRecord => ({
  workflow: 'issue',
  step: 'triage',
  status: 'done',
  tries: 0,
  rounds: {},
  sessions: {},
  started: '',
  ...run,
});

export const tmp = (name: string) => mkdtempSync(join(tmpdir(), `agentgraph-${name}-`));

export const issuePath = (dir: string, n: number, name = 'issue.md') => join(findIssueDir(dir, n), name);

export const writeIssueAt = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, text);
};

export const appendIssueAt = (path: string, text: string) => {
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, text);
};

export const findStatus = (dir: string, n: number) => {
  const at = findIssueDir(dir, n);
  return existsSync(join(at, 'issue.md')) ? relative(dir, dirname(at)) : undefined;
};

export const git = (cwd: string, ...args: string[]) =>
  execFileSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', '-c', 'commit.gpgsign=false', ...args], {
    cwd,
    encoding: 'utf8',
  }).trim();

export const write = (root: string, files: Record<string, string>) => {
  for (const [path, content] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), content);
  }
};

export const commit = (cwd: string, files: Record<string, string>) => {
  write(cwd, files);
  git(cwd, 'add', '.');
  git(cwd, 'commit', '-qm', 'c');
  return git(cwd, 'rev-parse', 'HEAD');
};

export const change = (before: Record<string, string>, after: Record<string, string> = {}, remove: string[] = []) => {
  const dir = tmp('change');
  git(dir, 'init', '-q', '-b', 'main');
  write(dir, { '.gitignore': 'node_modules/\n', ...before });
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base');
  const base = git(dir, 'rev-parse', 'HEAD');
  write(dir, after);
  for (const path of remove) rmSync(join(dir, path));
  return { dir, base };
};

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
