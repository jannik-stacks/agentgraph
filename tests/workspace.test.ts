import { existsSync, readFileSync } from 'node:fs';
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
    expect(readFileSync(join(mirror, 'config'), 'utf8')).not.toContain('secret');
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
});
