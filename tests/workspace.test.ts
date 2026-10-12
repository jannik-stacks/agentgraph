import { execFileSync } from 'node:child_process';
import { chmodSync, existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { workspaces } from '../src/workspace.ts';
import { commit, git, sourceRepo, temp } from './git.ts';

const setup = () => {
  const origin = sourceRepo();
  const dataDir = temp('data');
  const ws = workspaces({ dataDir, cloneUrl: () => origin.dir, token: async () => 'secret-token' });
  return { origin, dataDir, ws, mirror: join(dataDir, 'repos', 'acme', 'app.git') };
};

describe('workspaces', () => {
  it('mirrors once and checks out the default branch for a run', async () => {
    const { origin, ws, mirror } = setup();
    const path = await ws.create({ repo: 'acme/app' }, 'run-1');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(origin.main);
    expect(readFileSync(join(path, 'README.md'), 'utf8')).toBe('main\n');
    expect(git(mirror, 'config', '--get', 'remote.origin.mirror')).toBe('true');
    expect(readFileSync(join(mirror, 'config'), 'utf8')).not.toContain('extraheader');
  });

  it('fetches new commits and checks out the event ref', async () => {
    const { origin, ws } = setup();
    await ws.create({ repo: 'acme/app' }, 'run-1');
    git(origin.dir, 'checkout', '-q', 'feature');
    const head = commit(origin.dir, { 'more.txt': 'more\n' });
    const path = await ws.create({ repo: 'acme/app', ref: 'feature' }, 'run-2');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(head);
    expect(existsSync(join(path, 'feature.txt'))).toBe(true);
    const tagged = await ws.create({ repo: 'acme/app', ref: 'refs/heads/main' }, 'run-3');
    expect(git(tagged, 'rev-parse', 'HEAD')).toBe(origin.main);
  });

  it('checks out a pull request head ref', async () => {
    const { origin, ws } = setup();
    git(origin.dir, 'update-ref', 'refs/pull/1/head', origin.feature);
    const path = await ws.create({ repo: 'acme/app', ref: 'refs/pull/1/head' }, 'run-1');
    expect(git(path, 'rev-parse', 'HEAD')).toBe(origin.feature);
  });

  it('lists committed, modified and untracked changes without touching the index', async () => {
    const { ws } = setup();
    const path = await ws.create({ repo: 'acme/app' }, 'run-1');
    commit(path, { 'kept.txt': 'kept\n' });
    writeFileSync(join(path, 'README.md'), 'changed\n');
    writeFileSync(join(path, 'new.txt'), 'new\n');
    const { files, diff } = await ws.changes('run-1');
    expect(files.sort()).toEqual(['README.md', 'kept.txt', 'new.txt']);
    expect(diff).toContain('+changed');
    expect((await ws.changes('run-1', ['new.txt'])).diff).toMatch(/^diff --git a\/new.txt b\/new.txt\n[\s\S]*\+new$/);
    expect(git(path, 'status', '--porcelain')).toBe('M README.md\n?? new.txt');
    await expect(ws.changes('run-9')).rejects.toThrow('no worktree for run "run-9"');
  });

  it('removes the worktree and prunes it from the mirror', async () => {
    const { ws, mirror } = setup();
    const path = await ws.create({ repo: 'acme/app' }, 'run-1');
    await ws.remove('acme/app', 'run-1');
    expect(existsSync(path)).toBe(false);
    expect(git(mirror, 'worktree', 'list')).not.toContain('run-1');
    await expect(ws.remove('acme/unknown', 'run-9')).resolves.toBeUndefined();
  });

  it('rejects unknown refs and unsafe repository names', async () => {
    const { ws } = setup();
    await expect(ws.create({ repo: 'acme/app', ref: 'nope' }, 'run-1')).rejects.toThrow('git -C');
    await expect(ws.create({ repo: '../escape' }, 'run-2')).rejects.toThrow('invalid repository');
  });

  it('sends the token through the environment, never in argv', async () => {
    const bin = temp('bin');
    const log = join(bin, 'log');
    const real = execFileSync('sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
    const script = [
      '#!/bin/sh',
      `printf 'argv %s\\n' "$*" >> '${log}'`,
      `printf 'env %s %s\\n' "$GIT_CONFIG_KEY_0" "$GIT_CONFIG_VALUE_0" >> '${log}'`,
      `exec '${real}' "$@"`,
    ];
    writeFileSync(join(bin, 'git'), script.join('\n') + '\n');
    chmodSync(join(bin, 'git'), 0o755);
    const path = process.env.PATH;
    process.env.PATH = `${bin}:${path}`;
    try {
      const { ws, origin } = setup();
      const dir = await ws.create({ repo: 'acme/app' }, 'run-1');
      await ws.create({ repo: 'acme/app' }, 'run-2');
      git(dir, 'checkout', '-qb', 'bothub/1');
      const head = commit(dir, { 'a.ts': 'a\n' });
      await ws.publish('acme/app', 'run-1', { branch: 'bothub/1', files: ['a.ts'], message: 'bothub: x' });
      expect(git(origin.dir, 'rev-parse', 'bothub/1')).toBe(head);
    } finally {
      process.env.PATH = path;
    }
    const lines = readFileSync(log, 'utf8').split('\n');
    const basic = Buffer.from('x-access-token:secret-token').toString('base64');
    const argv = lines.filter(line => line.startsWith('argv '));
    expect(argv.filter(line => /clone --mirror|fetch --prune| push /.test(line))).toHaveLength(3);
    expect(argv.filter(line => line.includes('secret-token') || line.includes(basic))).toEqual([]);
    const header = `env http.https://github.com/.extraheader Authorization: basic ${basic}`;
    expect(lines.filter(line => line === header)).toHaveLength(3);
  });
});

describe('workspaces.publish', () => {
  const started = async () => {
    const { origin, ws } = setup();
    const path = await ws.create({ repo: 'acme/app' }, 'run-1');
    const publish = (files: string[], paths?: string[]) =>
      ws.publish('acme/app', 'run-1', { branch: 'bothub/7', files, ...(paths && { paths }), message: 'bothub: fix' });
    return { origin, ws, path, publish };
  };

  it('pushes the agent branch with its uncommitted listed files', async () => {
    const { origin, path, publish } = await started();
    git(path, 'checkout', '-qb', 'bothub/7');
    const committed = commit(path, { 'a.ts': 'a\n' });
    writeFileSync(join(path, 'b.ts'), 'b\n');
    expect(await publish(['a.ts', 'b.ts'], ['*.ts'])).toBe('https://github.com/acme/app/tree/bothub/7');
    expect(git(origin.dir, 'ls-tree', '--name-only', 'bothub/7').split('\n')).toEqual(['README.md', 'a.ts', 'b.ts']);
    expect(git(origin.dir, 'log', '-1', '--format=%an <%ae> %cn %s', 'bothub/7')).toBe(
      'bothub[bot] <bothub[bot]@users.noreply.github.com> bothub[bot] bothub: fix'
    );
    expect(git(origin.dir, 'rev-parse', 'bothub/7~1')).toBe(committed);
  });

  it('refuses uncommitted changes the proposal does not list', async () => {
    const { origin, path, publish } = await started();
    commit(path, { 'a.ts': 'a\n' });
    writeFileSync(join(path, 'b.ts'), 'b\n');
    writeFileSync(join(path, 'notes.txt'), 'scratch\n');
    await expect(publish(['a.ts', 'b.ts'])).rejects.toThrow(
      'uncommitted changes not listed in the proposal: notes.txt'
    );
    expect(() => git(origin.dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/bothub/7')).toThrow();
  });

  it('creates the branch at a detached head', async () => {
    const { origin, path, publish } = await started();
    const head = commit(path, { 'a.ts': 'a\n' });
    await publish(['a.ts']);
    expect(git(origin.dir, 'rev-parse', 'bothub/7')).toBe(head);
    expect(git(path, 'symbolic-ref', 'HEAD')).toBe('refs/heads/bothub/7');
  });

  it('refuses changes the proposal does not list or the job does not allow', async () => {
    const { origin, path, publish } = await started();
    commit(path, { 'a.ts': 'a\n', 'b.ts': 'b\n' });
    await expect(publish(['a.ts'])).rejects.toThrow('"b.ts" changed but is not listed in the proposal');
    await expect(publish(['a.ts', 'b.ts'], ['src/**'])).rejects.toThrow('path "a.ts" is outside the allowed paths');
    expect(() => git(origin.dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/bothub/7')).toThrow();
  });

  it('refuses an empty branch or one it cannot check out, and never forces', async () => {
    const { origin, ws, publish } = await started();
    await expect(publish([])).rejects.toThrow('branch "bothub/7" has no changes');

    git(origin.dir, 'branch', 'bothub/8', origin.feature);
    const other = await ws.create({ repo: 'acme/app' }, 'run-2');
    const push = () =>
      ws.publish('acme/app', 'run-2', { branch: 'bothub/8', files: ['c.ts', 'feature.txt'], message: 'm' });
    commit(other, { 'c.ts': 'c\n' });
    await expect(push()).rejects.toThrow('branch "bothub/8" exists but is not checked out');

    git(other, 'checkout', '-q', 'bothub/8');
    commit(other, { 'c.ts': 'c\n' });
    git(origin.dir, 'checkout', '-q', 'bothub/8');
    const moved = commit(origin.dir, { 'feature.txt': 'moved\n' });
    git(origin.dir, 'checkout', '-q', 'main');
    await expect(push()).rejects.toThrow(/git .*push/);
    expect(git(origin.dir, 'rev-parse', 'bothub/8')).toBe(moved);
  });
});
