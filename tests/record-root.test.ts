import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { basename, join } from 'node:path';
import { DatabaseSync } from 'node:sqlite';
import { Chunk, Effect, Layer, Stream } from 'effect';
import { afterEach, expect, it } from 'vitest';
import { fileForge } from '../src/forge.ts';
import { ensureBase, ensureGraph, ensureInstance } from '../src/instance.ts';
import { loadGraph } from '../src/folder.ts';
import { start as main, writeTriggeringIssue } from '../src/main.ts';
import { fileStore, Store } from '../src/store.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, seeded, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';

const runTs = join(import.meta.dirname, '..', 'bin', 'run.ts');
const sandboxGraph = join(import.meta.dirname, '..', 'examples', 'sandbox');

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
  delete process.env.AGENTGRAPH_FORGE;
  delete process.env.AGENTGRAPH_TRUST;
});

const inStore = <A, E>(data: string, use: (s: Store['Type']) => Effect.Effect<A, E>) =>
  Effect.runPromise(Effect.flatMap(Store, use).pipe(Effect.provide(fileStore(data))));

it('restores an instance from a copy of its folder without the cache', async () => {
  const w = seeded('record-root', { 'package.json': JSON.stringify({ scripts: { test: 'exit 0' } }) });
  dirs.push(w.root);
  git(w.seed, 'config', 'user.name', 'morgan');
  cpSync(sandboxGraph, join(w.seed, '.agentgraph'), { recursive: true });
  git(w.seed, 'add', '-A');
  git(w.seed, 'commit', '-qm', 'graph');
  const root = join(w.root, 'old');
  const i = await ensureInstance(root, w.seed);
  await ensureBase(i);
  const dir = await ensureGraph(i);
  const graph = await Effect.runPromise(loadGraph(dir, harnesses));
  await writeTriggeringIssue({ ...graph, trust: [i.owner] }, i.forge, 'Add a greeting', i.owner, 'issue');
  Object.assign(process.env, { AGENTGRAPH_FORGE: i.forge, AGENTGRAPH_TRUST: i.owner });
  const push = { kind: 'push', branch: 'agentgraph/1', message: 'feat: add hello' };
  const pull = { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Add hello', body: '' };
  const [run] = await main({ graph: dir, issue: 1, data: i.data, marked: true, base: i.base }, s =>
    Layer.mergeAll(
      fileForge(s.forge as string, undefined, s.trust),
      fileStore(s.data),
      hostSandbox(join(s.forge as string, 'origin.git')),
      replaySession([
        [start('i'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
        [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
      ])
    )
  );
  const ref = `refs/agentgraph/runs/${run!.id}`;
  const head = git(w.root, '--git-dir', join(i.forge, 'origin.git'), 'rev-parse', ref);
  const pinned = git(
    w.root,
    '--git-dir',
    join(i.forge, 'origin.git'),
    'rev-parse',
    `refs/agentgraph/graphs/${run!.graphTree}`
  );
  expect(pinned).toBe(git(w.seed, 'rev-parse', 'HEAD:.agentgraph'));
  expect(pinned).toBe(run!.graphTree);
  const bytes = new TextEncoder().encode('uploaded');
  const hash = await inStore(i.data, s => s.putFile(bytes, new AbortController().signal));

  const home = join(i.data, 'homes', 'h1', '.local', 'share');
  mkdirSync(home, { recursive: true });
  const db = new DatabaseSync(join(home, 'sessions.db'));
  db.exec(
    "PRAGMA journal_mode=WAL; PRAGMA wal_autocheckpoint=0; CREATE TABLE s (id TEXT); INSERT INTO s VALUES ('one');"
  );
  mkdirSync(join(i.data, 'cache', 'work'), { recursive: true });
  writeFileSync(join(i.data, 'cache', 'work', 'x'), 'rebuildable');

  expect(readdirSync(i.dir).toSorted()).toEqual(['data', 'forge', 'instance.yaml']);
  const moved = join(w.root, 'new');
  cpSync(i.dir, join(moved, basename(i.dir)), { recursive: true, filter: src => src !== join(i.data, 'cache') });
  db.close();
  rmSync(root, { recursive: true });

  const j = await ensureInstance(moved, w.seed);
  expect(j).toMatchObject({ made: false, dir: join(moved, basename(i.dir)) });
  const cli = (...args: string[]) =>
    spawnSync(process.execPath, [runTs, ...args, '--data', moved], {
      cwd: w.seed,
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '', AGENTGRAPH_FORGE: '', DOCKER_HOST: 'unix:///nonexistent' },
    });
  expect(cli('show').stdout).toContain(`#2 open Add hello`);
  expect(cli('show', '1').stdout).toContain('Add a greeting');
  const trace = await inStore(j.data, s => Stream.runCollect(s.read(run!.id)));
  expect(Chunk.size(trace)).toBeGreaterThan(0);
  expect(await inStore(j.data, s => s.readFile(hash))).toEqual(Buffer.from(bytes));
  expect(git(w.root, '--git-dir', join(j.forge, 'origin.git'), 'rev-parse', ref)).toBe(head);
  const copied = new DatabaseSync(join(j.data, 'homes', 'h1', '.local', 'share', 'sessions.db'));
  expect(copied.prepare('SELECT id FROM s').all()).toEqual([{ id: 'one' }]);
  copied.close();
});
