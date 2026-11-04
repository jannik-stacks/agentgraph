import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import { ensureInstance, readInstance } from '../src/instance.ts';
import { readInstanceEnv, start } from '../src/main.ts';
import { settings, makeTrackerSetup, whyModelHostsMissing } from '../src/services.ts';
import { makeServedGraph } from '../studio/served.ts';
import { fileStore, Store } from '../src/store.ts';
import { folderTracker } from '../src/tracker.ts';
import { makeTestGraph, seeded } from './fixtures.ts';
import { begin } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { removeAfter } from './world.ts';

const cli = join(import.meta.dirname, '../bin/run.ts');
const makeInstance = async (name: string) => {
  const world = seeded('instance-setup', { 'README.md': 'hello' });
  removeAfter(world.root);
  const root = join(world.root, 'instances');
  const instance = await ensureInstance(root, name, world.seed);
  const graph = join(world.root, 'graph');
  mkdirSync(graph);
  writeFileSync(join(graph, 'settings.yaml'), '{}');
  const save = (record: Partial<typeof instance>) =>
    writeFileSync(
      join(instance.dir, 'instance.yaml'),
      stringify({
        checkout: world.seed,
        repo: 'owner/repository',
        base: 'main',
        owner: 'owner',
        exported: {},
        loop: false,
        graph,
        ...record,
      })
    );
  save({});
  const run = (...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, '--instance', name, '--data', root], {
      cwd: world.root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '',
        AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
        AGENTGRAPH_SANDBOX_URL: 'http://unused',
      },
    });
  return { ...world, root, instance, graph, save, run };
};

it('keeps named instance data and trust under tracker and App overrides', async () => {
  const w = await makeInstance('bench');
  const file = join(w.root, 'keys.env');
  writeFileSync(file, 'AGENTGRAPH_PROXY_KEYS=*=only-in-file\nAGENTGRAPH_APP_ID=42\nAGENTGRAPH_TRACKER=selected\n');
  w.save({ env: file, provider: 'litellm', trust: ['only-owner'] });
  const plugin = join(w.graph, 'plugins');
  mkdirSync(plugin);
  const trust = join(w.root, 'trust.json');
  writeFileSync(
    join(plugin, 'selected.ts'),
    `import { writeFileSync } from 'node:fs';
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'selected', tracker: host => {
  const setup = folder.tracker(host);
  return { ...setup, layer: (trust, as) => { writeFileSync(${JSON.stringify(trust)}, JSON.stringify(trust)); return setup.layer(trust, as); } };
} };`
  );
  const result = w.run('loop', '--once', '--tracker', 'selected');
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  expect(JSON.parse(readFileSync(trust, 'utf8'))).toEqual(['only-owner']);
  expect(w.run('loop', '--once').status).toBe(0);
  const workflow = makeTestGraph('kit').workflows.issue!;
  const run = {
    ...begin(workflow, { id: 'saved', issue: 1, started: new Date().toISOString() }),
    status: 'waiting' as const,
    reason: 'answer',
  };
  await Effect.runPromise(Effect.flatMap(Store, s => s.put(run)).pipe(Effect.provide(fileStore(w.instance.data))));
  const labelled = w.run('label', 'saved', 'case=kept', '--tracker', 'folder');
  expect([labelled.status, labelled.stdout.trim()]).toEqual([0, 'case=kept']);
});

it('constructs a GitHub instance offline without a local origin or shell credentials', async () => {
  const w = await makeInstance('github');
  const file = join(w.root, 'app.env');
  writeFileSync(file, 'AGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_KEY=offline-key\n');
  const record = {
    checkout: w.seed,
    repo: 'owner/repository',
    graph: w.graph,
    base: 'main',
    owner: 'owner',
    tracker: 'github',
    env: file,
    loop: false,
    exported: {},
  };
  writeFileSync(join(w.instance.dir, 'instance.yaml'), stringify(record));
  rmSync(w.instance.tracker, { recursive: true });
  const instance = readInstance(w.root, 'github')!;
  const scope = await readInstanceEnv(instance);
  const setup = await makeTrackerSetup(
    await Effect.runPromise(settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config)))
  );
  expect(setup.origin).toMatchObject({ origin: 'https://github.com/owner/repository.git' });
  const checked = w.run('check');
  expect([checked.status, checked.stdout.trim(), checked.stderr]).toEqual([0, 'ok', '']);
});

it('authenticates a provider using credentials only in the instance env', async () => {
  const w = await makeInstance('auth');
  const file = join(w.root, 'keys.env');
  writeFileSync(file, 'ANTHROPIC_API_KEY=only-in-file\n');
  w.save({ env: file, provider: 'anthropic' });
  const result = w.run('loop', '--once', '--tracker', 'folder');
  expect([result.status, result.stdout]).toEqual([0, expect.stringContaining('anthropic')]);
});

it('prints the chosen name for both instances of one checkout', async () => {
  const w = await makeInstance('live');
  const bench = await ensureInstance(w.root, 'bench', w.seed);
  const workflow = makeTestGraph('kit').workflows.issue!;
  const run = {
    ...begin(workflow, { id: 'waiting', issue: 1, started: new Date().toISOString() }),
    status: 'waiting' as const,
    reason: 'answer',
  };
  await Effect.runPromise(
    Effect.forEach([w.instance, bench], i =>
      Effect.flatMap(Store, s => s.put(run)).pipe(Effect.provide(fileStore(i.data)))
    )
  );
  const result = spawnSync(process.execPath, [cli, 'show', '--data', w.root], {
    cwd: w.root,
    encoding: 'utf8',
    env: { PATH: process.env.PATH, NODE_OPTIONS: '', AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE },
  });
  expect([result.status, result.stdout]).toEqual([0, expect.stringMatching(/--instance bench[\s\S]*--instance live/)]);
});

it('shares scoped provider and config across check, studio reloads and execution', async () => {
  const w = await makeInstance('config');
  const config = join(w.root, 'config.ts');
  writeFileSync(
    config,
    `import { opencode } from ${JSON.stringify(new URL('../harnesses/opencode.ts', import.meta.url).href)};
export default { harnesses: [{ ...opencode(), name: 'scoped' }, { ...opencode(), name: 'other' }], providers: [{ name: 'scoped', harnesses: ['scoped'], ready: () => true }, { name: 'other', harnesses: ['other'], ready: () => true }] };`
  );
  const env = join(w.root, 'keys.env');
  writeFileSync(env, `AGENTGRAPH_CONFIG=${config}\nAGENTGRAPH_PROVIDER=scoped\n`);
  w.save({ env, provider: 'litellm' });
  mkdirSync(join(w.graph, 'agents'));
  writeFileSync(join(w.graph, 'agents/a.md'), '---\n---\nHello');
  mkdirSync(join(w.graph, 'workflows'));
  writeFileSync(join(w.graph, 'workflows/test.md'), '---\non: issues\nagent: a\n---\n');
  const unbound = join(w.root, 'unused');
  const validated = spawnSync(process.execPath, [cli, 'check', '--repo', w.seed, '--dir', w.graph, '--data', unbound], {
    cwd: w.seed,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '',
      AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
      AGENTGRAPH_CONFIG: config,
      AGENTGRAPH_PROVIDER: 'scoped',
    },
  });
  expect([validated.status, validated.stdout.trim(), existsSync(unbound)]).toEqual([0, 'ok', false]);
  const checked = w.run('check');
  expect([checked.status, checked.stdout.trim(), checked.stderr]).toEqual([0, 'ok', '']);
  vi.stubEnv('AGI_STUDIO_DIR', w.graph);
  vi.stubEnv('AGI_STUDIO_INSTANCE', JSON.stringify({ root: w.root, name: 'config' }));
  const reader = makeServedGraph();
  try {
    expect((await reader.read())?.graph?.agents.a?.harness).toBe('scoped');
    writeFileSync(env, `AGENTGRAPH_CONFIG=${config}\nAGENTGRAPH_PROVIDER=other\n`);
    reader.forget();
    expect((await reader.read())?.graph?.agents.a?.harness).toBe('other');
    expect(w.run('check').status).toBe(0);
    const instance = readInstance(w.root, 'config')!;
    const result = await start({ graph: w.graph, issue: 'all', data: instance.data, instance }, s =>
      Layer.mergeAll(
        folderTracker(instance.tracker, undefined, s.trust),
        fileStore(s.data),
        hostSandbox(join(instance.tracker, 'origin.git')),
        replaySession([])
      )
    );
    expect(result).toEqual([]);
  } finally {
    vi.unstubAllEnvs();
  }
});

it('resolves independent instance environments without changing the engine environment', async () => {
  const before = { ...process.env };
  const live = await readInstanceEnv({
    repo: 'owner/live',
    owner: 'alice',
    trust: [],
    image: 'sandbox:live',
    data: '/unused/live',
  });
  const bench = await readInstanceEnv({
    repo: 'owner/bench',
    owner: 'bob',
    image: 'sandbox:bench',
    data: '/unused/bench',
  });
  expect([live.env, bench.env]).toMatchObject([
    {
      AGENTGRAPH_REPO: 'owner/live',
      AGENTGRAPH_TRUST: '',
      AGENTGRAPH_IMAGE: 'sandbox:live',
      AGENTGRAPH_DATA: '/unused/live',
    },
    {
      AGENTGRAPH_REPO: 'owner/bench',
      AGENTGRAPH_TRUST: 'bob',
      AGENTGRAPH_IMAGE: 'sandbox:bench',
      AGENTGRAPH_DATA: '/unused/bench',
    },
  ]);
  expect(process.env).toEqual(before);
});

it('checks model readiness using the instance env file', async () => {
  const w = await makeInstance('models');
  const file = join(w.root, 'models.env');
  writeFileSync(file, 'AGENTGRAPH_PROXY_URL=https://models.example.com\n');
  const scope = await readInstanceEnv({ ...w.instance, env: file });
  expect(
    await Effect.runPromise(
      whyModelHostsMissing.pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
    )
  ).toBeUndefined();
  const bin = join(w.root, 'bin');
  mkdirSync(bin);
  writeFileSync(join(bin, 'docker'), '#!/bin/sh\nexit 0\n', { mode: 0o755 });
  writeFileSync(file, 'AGENTGRAPH_PROXY_URL=http://missing-model:4000\n');
  const local = await readInstanceEnv({ ...w.instance, env: file });
  const path = process.env.PATH;
  process.env.PATH = `${bin}:${path ?? ''}`;
  try {
    expect(
      await Effect.runPromise(
        whyModelHostsMissing.pipe(Effect.provideService(ConfigProvider.ConfigProvider, local.config))
      )
    ).toContain('Nothing answers to missing-model');
  } finally {
    if (path === undefined) delete process.env.PATH;
    else process.env.PATH = path;
  }
});
