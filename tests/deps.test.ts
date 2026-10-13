import { lstatSync, mkdirSync, readdirSync, readFileSync, readlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { compile } from '../src/config.ts';
import { depsKey, prepareDeps, withDeps, type Deps } from '../src/deps.ts';
import { runScript, unsandboxed } from '../src/runner.ts';
import { depsMounts } from '../src/sandbox.ts';
import { commit, git, sourceRepo, temp } from './kit.ts';

const FLAKY_INSTALLS = [
  {
    case: 'again after a dropped proxy connection, in a cleared worktree',
    fails: 2,
    output: 'npm error code FETCH_ERROR: Proxy connection ended before receiving CONNECT response',
    delays: [0, 0, 0],
    installs: 3,
    error: undefined,
  },
  {
    case: 'again after a reset connection',
    fails: 1,
    output: 'npm error code ECONNRESET',
    delays: [0],
    installs: 2,
    error: undefined,
  },
  {
    case: 'again after npm quits with its exit handler never called',
    fails: 1,
    output: 'npm error Exit handler never called!',
    delays: [0],
    installs: 2,
    error: undefined,
  },
  {
    case: 'no more than its delays allow',
    fails: 9,
    output: 'npm error code ETIMEDOUT',
    delays: [0, 0],
    installs: 3,
    error: 'installing dependencies failed: npm error code ETIMEDOUT',
  },
  {
    case: 'once when the install fails for a reason other than the network',
    fails: 9,
    output: 'npm error code ERESOLVE',
    delays: [0, 0],
    installs: 1,
    error: 'installing dependencies failed: npm error code ERESOLVE',
  },
] as const;

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
    expect(await depsMounts(a, true)).toEqual([
      { src: entry, dst: entry, readonly: true },
      { src: join(a, 'vendor'), dst: '/work/vendor' },
      { src: join(a, 'sub/vendor'), dst: '/work/sub/vendor' },
    ]);

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

  it('links .bin but not a cache dir a tool left in the install, so every worktree can write its own', async () => {
    const { deps, worktree, cache } = setup();
    const a = worktree('a');
    await prepareDeps(a, deps, cache, unsandboxed);
    const entry = join(cache, await depsKey(a, deps));
    mkdirSync(join(entry, 'vendor', '.vite-temp'));
    mkdirSync(join(entry, 'vendor', '.bin'));
    const b = worktree('b');
    await prepareDeps(b, deps, cache, unsandboxed);
    expect(readdirSync(join(b, 'vendor')).sort()).toEqual(['.bin', '.bothub-deps', 'pkg']);
  });

  it('installs once for worktrees that ask at the same time', async () => {
    const { deps, worktree, runs, cache } = setup();
    const trees = ['a', 'b', 'c'].map(worktree);
    await Promise.all(
      trees.map(tree => prepareDeps(tree, { ...deps, install: `sleep 0.2; ${deps.install}` }, cache, unsandboxed))
    );
    expect(runs()).toBe(1);
    for (const tree of trees) expect(readFileSync(join(tree, 'vendor', 'pkg', 'index.js'), 'utf8')).toBe('v1\n');
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

  it.each(FLAKY_INSTALLS)('tries $case', async ({ fails, output, delays, installs, error }) => {
    const { deps, worktree, cache } = setup();
    const count = join(temp('deps-count'), 'count');
    const flaky = `n=$(cat ${count} 2>/dev/null || echo 0); echo $((n+1)) > ${count}; [ ! -e vendor/stale ] || exit 7; [ "$n" -ge ${fails} ] || { mkdir -p vendor/stale; echo "${output}"; exit 1; }; ${deps.install}`;
    const tree = worktree('a');
    const prepared = prepareDeps(tree, { ...deps, install: flaky }, cache, unsandboxed, undefined, delays);
    if (error) await expect(prepared).rejects.toThrow(error);
    else await prepared;
    expect(Number(readFileSync(count, 'utf8'))).toBe(installs);
    if (!error) expect(readdirSync(join(tree, 'vendor')).sort()).toEqual(['.bothub-deps', 'pkg']);
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
