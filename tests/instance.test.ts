import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { parse, stringify } from 'yaml';
import { ConfigProvider, Config, Effect } from 'effect';
import { expect, it, vi } from 'vitest';
import { ensureGraph, ensureInstanceGraph, ensureInstance, findInstances } from '../src/instance.ts';
import { readInstanceEnv } from '../src/main.ts';
import { commit } from './kit.ts';
import { seeded } from './fixtures.ts';

it('names two independent instances of one checkout within an explicit root', async () => {
  const { root, seed } = seeded('named-instance', { 'file.txt': 'content' });
  const data = join(root, 'instances');
  const live = await ensureInstance(data, 'live', seed);
  const bench = await ensureInstance(data, 'bench', seed);
  expect([live.dir, bench.dir]).toEqual([join(data, 'live'), join(data, 'bench')]);
  expect(findInstances(data).map(i => i.checkout)).toEqual([live.checkout, live.checkout]);
  expect(findInstances(join(root, 'other'))).toEqual([]);
  expect((await ensureInstance(data, 'live', seed)).made).toBe(false);
  await expect(ensureInstance(data, '../escape', seed)).rejects.toThrow('one path component');
  const other = seeded('other-instance', { 'file.txt': 'content' });
  await expect(ensureInstance(data, 'live', other.seed)).rejects.toThrow('belongs to');
});

it('reads every instance field strictly and resolves paths against its folder', async () => {
  const { root, seed } = seeded('instance-fields', { 'file.txt': 'content' });
  const instance = await ensureInstance(join(root, 'instances'), 'live', seed);
  const file = join(instance.dir, 'instance.yaml');
  const record = {
    ...parse(readFileSync(file, 'utf8')),
    repo: 'owner/repository',
    graph: '../../seed',
    env: '../keys.env',
    loop: true,
    trust: [],
    image: 'sandbox:custom',
    limits: { parallel: 1 },
  };
  writeFileSync(file, stringify(record));
  const [read] = findInstances(join(root, 'instances'));
  expect(read).toMatchObject({
    repo: 'owner/repository',
    env: join(root, 'instances', 'keys.env'),
    graph: seed,
    loop: true,
    trust: [],
    image: 'sandbox:custom',
    limits: { parallel: 1 },
  });
  writeFileSync(file, stringify({ ...record, unknown: true }));
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(findInstances(join(root, 'instances'))).toEqual([]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(`skipping ${file}: `));
  warn.mockRestore();
  writeFileSync(file, stringify(record));
  await expect(ensureGraph(read!)).resolves.toBe(seed);
});

it('selects the updated committed graph before callers discover plugins', async () => {
  const w = seeded('instance-snapshot', { '.agentgraph/settings.yaml': 'image: sandbox:old\n' });
  const i = await ensureInstance(join(w.root, 'instances'), 'live', w.seed);
  commit(w.seed, { '.agentgraph/settings.yaml': 'image: sandbox:reviewed\n' });
  writeFileSync(join(w.seed, '.agentgraph/settings.yaml'), 'image: sandbox:unreviewed\n');
  const graph = await ensureInstanceGraph(i);
  expect(readFileSync(join(graph, 'settings.yaml'), 'utf8')).toBe('image: sandbox:reviewed\n');
  expect(await ensureInstanceGraph(i)).toBe(graph);
});

it('skips an old record in the listing with a warning', async () => {
  const { root, seed } = seeded('old-record', { 'file.txt': 'content' });
  const data = join(root, 'instances');
  const live = await ensureInstance(data, 'live', seed);
  mkdirSync(join(data, 'old-6ff957-local'));
  writeFileSync(
    join(data, 'old-6ff957-local', 'instance.yaml'),
    stringify({ repo: seed, base: 'main', owner: 'o', exported: {} })
  );
  const warn = vi.spyOn(console, 'error').mockImplementation(() => {});
  expect(findInstances(data).map(i => i.dir)).toEqual([live.dir]);
  expect(warn).toHaveBeenCalledWith(expect.stringContaining(join(data, 'old-6ff957-local', 'instance.yaml')));
  warn.mockRestore();
});

it('makes an unnamed instance only beside instances of other checkouts', async () => {
  const { root, seed } = seeded('implicit-instance', { 'file.txt': 'content' });
  const other = seeded('implicit-other', { 'file.txt': 'content' });
  const data = join(root, 'instances');
  const first = await ensureInstance(data, undefined, seed);
  expect([first.made, first.dir]).toEqual([true, join(data, 'seed')]);
  expect((await ensureInstance(data, undefined, seed)).made).toBe(false);
  const next = join(root, 'next');
  await ensureInstance(next, 'mine', other.seed);
  expect((await ensureInstance(next, undefined, seed)).made).toBe(true);
  const flat = join(root, 'flat');
  mkdirSync(join(flat, 'runs'), { recursive: true });
  await expect(ensureInstance(flat, undefined, seed)).rejects.toThrow(`${flat} has no instance seed but holds runs`);
  const old = join(root, 'old');
  mkdirSync(join(old, 'seed-6ff957-local'), { recursive: true });
  writeFileSync(join(old, 'seed-6ff957-local', 'instance.yaml'), stringify({ repo: seed }));
  await expect(ensureInstance(old, undefined, seed)).rejects.toThrow('holds seed-6ff957-local; pass --instance');
  const renamed = join(root, 'renamed');
  await ensureInstance(renamed, 'live', seed);
  await expect(ensureInstance(renamed, undefined, seed)).rejects.toThrow('holds live');
  expect((await ensureInstance(flat, 'seed', seed)).made).toBe(true);
});

it('treats an empty AGENTGRAPH_PROVIDER as unset so the record provider wins', async () => {
  vi.stubEnv('AGENTGRAPH_PROVIDER', '');
  try {
    const scope = await readInstanceEnv({ provider: 'saved', data: '/unused' });
    const named = await Effect.runPromise(
      Config.String('AGENTGRAPH_PROVIDER').pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
    );
    expect(named).toBe('saved');
  } finally {
    vi.unstubAllEnvs();
  }
});

const readTracker = async (instance: object, flags = {}) =>
  (await readInstanceEnv({ data: '/unused', ...instance }, {}, {}, flags)).env.AGENTGRAPH_TRACKER;

it('lets an instance tracker beat the tracker env and the App env, below the --tracker flag', async () => {
  for (const name of ['AGENTGRAPH_TRACKER', 'AGENTGRAPH_APP_ENV', 'AGENTGRAPH_APP_KEY', 'AGENTGRAPH_APP_KEY_FILE'])
    vi.stubEnv(name, '');
  vi.stubEnv('AGENTGRAPH_APP_ID', '42');
  try {
    expect(await readTracker({})).toBe('github');
    expect(await readTracker({ trackerName: 'folder' })).toBe('folder');
    vi.stubEnv('AGENTGRAPH_TRACKER', 'github');
    expect(await readTracker({ trackerName: 'folder' })).toBe('folder');
    expect(await readTracker({ trackerName: 'folder' }, { AGENTGRAPH_TRACKER: 'github' })).toBe('github');
  } finally {
    vi.unstubAllEnvs();
  }
});
