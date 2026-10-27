import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, existsSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from 'node:fs';
import { delimiter, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { dockerSandbox } from '../src/docker.ts';
import { reap } from '../src/env.ts';
import { fileForge } from '../src/forge.ts';
import {
  ensureBase,
  ensureGraph,
  ensureInstance,
  mergePull,
  formatGraphName,
  whyGraphUncommitted,
  writePullToRepo,
  writeReview,
} from '../src/instance.ts';
import { loadGraph } from '../src/folder.ts';
import { start as main, writeTriggeringIssue } from '../src/main.ts';
import type { Proposal } from '../src/proposal.ts';
import { fileStore } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, seeded, start, wrote } from './fixtures.ts';
import { git, tmp } from './kit.ts';

const sandboxGraph = join(import.meta.dirname, '..', 'examples', 'sandbox');
const hooks = (
  'pre-commit commit-msg post-checkout post-commit reference-transaction pre-push post-merge pre-receive update ' +
  'post-receive post-update post-rewrite post-index-change pre-auto-gc'
).split(' ');

const files = (dir: string, skip: RegExp) =>
  Object.fromEntries(
    readdirSync(dir, { recursive: true, encoding: 'utf8' })
      .filter(p => !skip.test(p) && statSync(join(dir, p)).isFile())
      .map(p => [
        p,
        createHash('sha256')
          .update(readFileSync(join(dir, p)))
          .digest('hex'),
      ])
  );

const userRepo = () => {
  const { root, seed } = seeded('user-repo', {
    'package.json': JSON.stringify({ scripts: { test: 'true' } }),
    'notes.txt': 'notes\n',
    '.agentgraph/README.md': 'a graph\n',
  });
  git(seed, 'config', 'user.name', 'morgan');
  git(seed, 'branch', 'agentgraph-notes');
  git(seed, 'checkout', '-q', '-b', 'feature');
  writeFileSync(join(seed, 'notes.txt'), 'notes\nstaged\n');
  git(seed, 'add', 'notes.txt');
  writeFileSync(join(seed, 'notes.txt'), 'notes\nstaged\nunstaged\n');
  writeFileSync(join(seed, 'wip.txt'), 'untracked\n');
  const ran = join(root, 'hooks-ran');
  for (const hook of hooks) {
    writeFileSync(join(seed, '.git', 'hooks', hook), `#!/bin/sh\necho ${hook} >> ${ran}\nexit 1\n`);
    chmodSync(join(seed, '.git', 'hooks', hook), 0o755);
  }
  utimesSync(join(seed, '.agentgraph', 'README.md'), new Date(), new Date(Date.now() + 60_000));
  git(seed, 'config', 'commit.gpgsign', 'true');
  git(seed, 'config', 'gpg.format', 'ssh');
  git(seed, 'config', 'user.signingkey', join(root, 'no-such-key'));
  return { root, seed, ran };
};

const quiet = (cwd: string, ...args: string[]) =>
  spawnSync('git', args, { cwd, encoding: 'utf8', env: { ...process.env, GIT_OPTIONAL_LOCKS: '0' } }).stdout.trim();

const look = (repo: string) => ({
  refs: quiet(repo, 'for-each-ref', '--format=%(refname) %(objectname) %(symref)')
    .split('\n')
    .filter(l => !l.startsWith('refs/heads/agentgraph/')),
  status: quiet(repo, 'status', '--porcelain=v2', '--branch', '--untracked-files=all'),
  head: [quiet(repo, 'symbolic-ref', 'HEAD'), quiet(repo, 'rev-parse', 'HEAD')],
  index: createHash('sha256')
    .update(readFileSync(join(repo, '.git', 'index')))
    .digest('hex'),
  git: files(join(repo, '.git'), /^(objects|refs\/heads\/agentgraph|logs\/refs\/heads\/agentgraph)(\/|$)/),
  tree: files(repo, /^\.git(\/|$)/),
});

const binDir = tmp('fake-docker');
const path = process.env.PATH;
beforeAll(() => {
  writeFileSync(
    join(binDir, 'docker'),
    [
      '#!/bin/sh',
      '[ "$1" = network ] && { echo true; exit 0; }',
      '[ "$1" = image ] && { echo sha256:x; exit 0; }',
      'exit 0',
    ].join('\n')
  );
  chmodSync(join(binDir, 'docker'), 0o755);
  process.env.PATH = `${binDir}${delimiter}${path}`;
});
afterAll(() => {
  process.env.PATH = path;
  delete process.env.AGENTGRAPH_FORGE;
  delete process.env.AGENTGRAPH_TRUST;
  delete process.env.AGENTGRAPH_PROXY_KEYS;
});

const drive = (i: { forge: string; data: string; base: string }, turns: SessionEvent[][]) =>
  main({ graph: sandboxGraph, issue: 1, data: i.data, marked: true, base: i.base }, s =>
    Layer.mergeAll(
      fileForge(s.forge as string, undefined, s.trust),
      fileStore(s.data),
      dockerSandbox({ data: s.data, origin: join(s.forge as string, 'origin.git'), local: true, cache: '' }),
      replaySession(turns)
    )
  );

const push = (message: string): Proposal => ({ kind: 'push', branch: 'agentgraph/1', message });
const pull: Proposal = { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Add hello', body: '' };

describe("the user's repo", () => {
  it('comes out of a whole run byte-identical but for agentgraph/ branches and new objects', async () => {
    const { root, seed, ran } = userRepo();
    const before = look(seed);
    const data = join(root, 'agentgraph-data');

    const i = await ensureInstance(data, seed, 'main');
    expect(await ensureBase(i)).toBeUndefined();
    const graph = await ensureGraph(i);
    expect(await whyGraphUncommitted(i, graph)).toBeUndefined();
    expect(await formatGraphName(i, graph)).toMatch(/^\.agentgraph\/ at main [0-9a-f]{7}$/);
    const loaded = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    expect(
      await writeTriggeringIssue({ ...loaded, trust: [i.owner] }, i.forge, 'Add a greeting', i.owner, 'issue')
    ).toBe(1);
    Object.assign(process.env, {
      AGENTGRAPH_FORGE: i.forge,
      AGENTGRAPH_TRUST: i.owner,
      AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2',
    });

    const first = await drive(i, [
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(first.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(existsSync(join(i.data, 'mirror.git'))).toBe(false);
    expect(await writePullToRepo(i, 1, { auto: true })).toMatchObject({ ref: 'agentgraph/1' });
    expect(git(seed, 'show', 'agentgraph/1:hello.txt')).toBe('hello');

    await writeReview(i.forge, i.owner, 1, 'changes_requested', 'say world');
    const second = await drive(i, [
      [start('i'), wrote('hello.txt', 'hello world\n'), reply(push('fix: say hello world'))],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(second.map(r => [r.step, r.status])).toEqual([['merge', 'waiting']]);
    expect(await writePullToRepo(i, 1)).toMatchObject({ ref: 'agentgraph/1' });
    expect(git(seed, 'show', 'agentgraph/1:hello.txt')).toBe('hello world');
    const patch = join(root, 'hello.patch');
    expect(await writePullToRepo(i, 1, { patch })).toMatchObject({ ref: patch });
    await expect(writePullToRepo(i, 1, { patch })).rejects.toThrow('EEXIST');

    expect(await mergePull(i, 1)).toMatchObject({ branch: 'agentgraph/1' });
    expect(await ensureBase(i)).toBeUndefined();
    expect(await writePullToRepo(i, 1, { auto: true })).toMatchObject({ ref: 'agentgraph/1' });
    expect(git(join(i.forge, 'origin.git'), 'show', 'main:hello.txt')).toBe('hello world');
    reap(i.data);
    expect(readdirSync(join(i.data, 'work'))).toEqual([]);
    expect(readdirSync(join(i.forge, 'origin.git', 'worktrees'))).toEqual([]);

    expect(look(seed)).toEqual(before);
    expect(existsSync(ran)).toBe(false);
    expect(quiet(seed, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentgraph/')).toBe(
      'refs/heads/agentgraph/1'
    );
    expect(quiet(seed, 'fsck', '--connectivity-only', '--no-dangling')).toBe('');
    expect(readdirSync(join(seed, '.git', 'objects', 'pack')).filter(f => f.endsWith('.keep'))).toEqual([]);

    git(seed, '-c', 'core.hooksPath=/dev/null', 'branch', '-D', 'agentgraph/1');
    expect(await writePullToRepo(i, 1, { auto: true })).toMatchObject({ why: expect.stringContaining('deleted') });
    git(seed, '-c', 'core.hooksPath=/dev/null', 'symbolic-ref', 'refs/heads/agentgraph/1', 'refs/heads/main');
    const main = quiet(seed, 'rev-parse', 'main');
    expect(await writePullToRepo(i, 1)).toMatchObject({ why: expect.stringContaining('moved') });
    expect(quiet(seed, 'rev-parse', 'main')).toBe(main);
  });

  it('gets nothing written by a read-only instance', async () => {
    const { root, seed, ran } = userRepo();
    const before = { ...look(seed), objects: files(join(seed, '.git', 'objects'), /^$/) };
    const data = join(root, 'agentgraph-data');
    const i = await ensureInstance(data, seed, 'main', true);
    expect((await ensureInstance(data, seed)).readonly).toBe(true);
    expect(await ensureBase(i)).toBeUndefined();
    const loaded = await Effect.runPromise(loadGraph(sandboxGraph, harnesses));
    await writeTriggeringIssue({ ...loaded, trust: [i.owner] }, i.forge, 'Add a greeting', i.owner, 'issue');
    Object.assign(process.env, {
      AGENTGRAPH_FORGE: i.forge,
      AGENTGRAPH_TRUST: i.owner,
      AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2',
    });
    await drive(i, [
      [start('i'), wrote('hello.txt', 'hello\n'), reply(push('feat: add hello'), pull)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(await writePullToRepo(i, 1, { auto: true })).toMatchObject({ why: expect.stringContaining('--patch') });
    expect(await writePullToRepo(i, 1, { as: 'mine' })).toMatchObject({ why: expect.stringContaining('--patch') });
    expect({ ...look(seed), objects: files(join(seed, '.git', 'objects'), /^$/) }).toEqual(before);
    expect(quiet(seed, 'for-each-ref', 'refs/heads/agentgraph/')).toBe('');
    expect(existsSync(ran)).toBe(false);
    rmSync(root, { recursive: true, force: true });
  });
});
