import { lstatSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { depsKey, prepareDeps, withDeps, type Deps } from '../src/deps.ts';
import { runScript, unsandboxed } from '../src/runner.ts';
import { depsMounts } from '../src/sandbox.ts';
import { commit, git, sourceRepo, temp } from './git.ts';

const setup = () => {
  const { dir } = sourceRepo();
  commit(dir, { 'deps.lock': 'v1\n' });
  const log = join(temp('deps-log'), 'log');
  const deps: Deps = {
    install: `echo ran >> ${log}; mkdir -p vendor/pkg sub/vendor; echo "$(cat deps.lock)" > vendor/pkg/index.js; touch sub/vendor/x`,
    lockfiles: ['deps.lock'],
    dirs: ['vendor', 'sub/vendor'],
    'timeout-minutes': 1,
  };
  const worktree = (name: string) => {
    const path = join(temp('deps-work'), name);
    git(dir, 'worktree', 'add', '-q', '--detach', path);
    return path;
  };
  const runs = () => readFileSync(log, 'utf8').split('\n').filter(Boolean).length;
  return { deps, worktree, runs, cache: temp('deps-cache') };
};

describe('prepareDeps', () => {
  it('installs once per lockfile content and links the dirs into every worktree, kept out of git', async () => {
    const { deps, worktree, runs, cache } = setup();
    const a = worktree('a');
    await prepareDeps(a, deps, cache, unsandboxed);
    const entry = join(cache, await depsKey(a, deps));
    expect(runs()).toBe(1);
    expect(readlinkSync(join(a, 'vendor', 'pkg'))).toBe(join(entry, 'vendor', 'pkg'));
    expect(readFileSync(join(a, 'vendor', 'pkg', 'index.js'), 'utf8')).toBe('v1\n');
    expect(lstatSync(join(a, 'sub', 'vendor')).isDirectory()).toBe(true);
    writeFileSync(join(a, 'vendor', '.cache'), 'tools write here');
    expect(git(a, 'status', '--porcelain')).toBe('');
    expect(await depsMounts(a)).toEqual([{ src: entry, dst: entry, readonly: true }]);

    const b = worktree('b');
    await prepareDeps(b, deps, cache, unsandboxed);
    await prepareDeps(b, deps, cache, unsandboxed);
    expect(runs()).toBe(1);
    expect(readlinkSync(join(b, 'sub', 'vendor', 'x'))).toBe(join(entry, 'sub', 'vendor', 'x'));

    writeFileSync(join(b, 'deps.lock'), 'v2\n');
    await prepareDeps(b, deps, cache, unsandboxed);
    expect(runs()).toBe(2);
    expect(readFileSync(join(b, 'vendor', 'pkg', 'index.js'), 'utf8')).toBe('v2\n');
    expect(readFileSync(join(a, 'vendor', 'pkg', 'index.js'), 'utf8')).toBe('v1\n');
    expect(git(b, 'status', '--porcelain')).toBe('M deps.lock');
  });

  it('fails when the install fails or leaves a dir out, and does nothing outside a worktree', async () => {
    const { deps, worktree, cache } = setup();
    await expect(
      prepareDeps(worktree('a'), { ...deps, install: 'echo broken; exit 3' }, cache, unsandboxed)
    ).rejects.toThrow('installing dependencies failed: broken');
    await expect(prepareDeps(worktree('b'), { ...deps, install: 'mkdir vendor' }, cache, unsandboxed)).rejects.toThrow(
      'installing dependencies left no sub/vendor'
    );
    const plain = temp('deps-plain');
    await prepareDeps(plain, deps, cache, unsandboxed);
    expect(await depsMounts(plain)).toEqual([]);
  });

  it('readies a worktree before a script starts in it', async () => {
    const { deps, worktree, cache } = setup();
    const launch = withDeps(unsandboxed, deps, cache);
    expect(await runScript('cat vendor/pkg/index.js', worktree('a'), 1, {}, launch)).toMatchObject({
      ok: true,
      output: 'v1',
    });
  });

  it('is configured in hub.yaml with paths inside the repository', () => {
    const hub = (deps: string) => compile([{ path: 'hub.yaml', source: `deps: ${deps}\n` }]);
    const ok = hub('{ install: npm ci, lockfiles: [package-lock.json], dirs: [node_modules] }');
    expect(ok.ok && ok.config.hub.deps).toEqual({
      install: 'npm ci',
      lockfiles: ['package-lock.json'],
      dirs: ['node_modules'],
      'timeout-minutes': 15,
    });
    expect(hub('{ install: npm ci, lockfiles: [package-lock.json], dirs: [../node_modules] }').ok).toBe(false);
  });
});
