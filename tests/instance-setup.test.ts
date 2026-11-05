import { spawn, spawnSync } from 'node:child_process';
import {
  cpSync,
  existsSync,
  mkdirSync,
  readFileSync,
  realpathSync,
  rmSync,
  symlinkSync,
  utimesSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { ConfigProvider, Effect, Layer } from 'effect';
import { expect, it, vi } from 'vitest';
import { stringify } from 'yaml';
import type { InstanceFile } from '../src/settings.ts';
import { ensureInstance, formatGraphName, readInstance } from '../src/instance.ts';
import { getCachePath } from '../src/env.ts';
import { readInstanceEnv, start, createLoopLock } from '../src/main.ts';
import { settings, makeTrackerSetup, whyModelHostsMissing } from '../src/services.ts';
import { makeServedGraphs } from '../studio/served.ts';
import { fileStore, Store } from '../src/store.ts';
import { folderTracker, writeIssueFile } from '../src/tracker.ts';
import { makeTestGraph, seeded } from './fixtures.ts';
import { begin } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { git } from './kit.ts';
import { makeStudioPagesPlugin } from '../studio/plugins.ts';
import { studioDir } from './studio.ts';
import { pathToFileURL } from 'node:url';
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
  const save = (
    record: Partial<{ [Key in keyof typeof InstanceFile.Type]: (typeof InstanceFile.Type)[Key] | undefined }>
  ) =>
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
  const runWithEnv = (env: Record<string, string | undefined>, ...args: string[]) =>
    spawnSync(process.execPath, [cli, ...args, '--instance', name, '--data', root], {
      cwd: world.root,
      encoding: 'utf8',
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '',
        AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
        AGENTGRAPH_SANDBOX_URL: 'http://unused',
        ...env,
      },
    });
  return { ...world, root, instance, graph, save, run: (...args: string[]) => runWithEnv({}, ...args), runWithEnv };
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

it('refuses start and say on a hosted tracker, where the App posts as an untrusted bot', async () => {
  const w = await makeInstance('hosted');
  const env = join(w.root, 'app.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_KEY=offline-key\n');
  w.save({ tracker: 'github', env, provider: 'anthropic' });
  rmSync(w.instance.tracker, { recursive: true });
  const refused = [
    ['start', 'Fix it'],
    ['say', '1', 'hi'],
  ].map(args => w.run(...args));
  expect(refused.map(r => [r.status, r.stdout, r.stderr])).toEqual([
    [2, '', expect.stringContaining('open the issue on the tracker')],
    [2, '', expect.stringContaining('comment on the tracker')],
  ]);
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

it('refuses an unknown --instance name unless --repo creates it', async () => {
  const w = await makeInstance('live');
  const show = (...args: string[]) =>
    spawnSync(process.execPath, [cli, 'show', '--instance', 'lvie', '--data', w.root, ...args], {
      cwd: w.seed,
      encoding: 'utf8',
      env: { PATH: process.env.PATH, NODE_OPTIONS: '', AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE },
    });
  const typo = show();
  expect([typo.status, typo.stderr]).toEqual([
    2,
    expect.stringContaining(`no instance lvie under ${w.root}; it holds live`),
  ]);
  expect(existsSync(join(w.root, 'lvie'))).toBe(false);
  expect(show('--repo', w.seed).status).toBe(0);
  expect(readInstance(w.root, 'lvie')?.checkout).toBe(realpathSync(w.seed));
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
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root: w.root, names: ['config'] }));
  const reader = makeServedGraphs();
  try {
    expect((await reader.read())[0]?.graph?.agents.a?.harness).toBe('scoped');
    writeFileSync(env, `AGENTGRAPH_CONFIG=${config}\nAGENTGRAPH_PROVIDER=other\n`);
    reader.forget();
    expect((await reader.read())[0]?.graph?.agents.a?.harness).toBe('other');
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

it('selects the committed graph before discovering tracker and execution plugins', async () => {
  const w = await makeInstance('snapshot');
  const graph = join(w.seed, '.agentgraph');
  cpSync(w.graph, graph, { recursive: true });
  mkdirSync(join(graph, 'plugins'));
  const selected = join(w.root, 'selected');
  const driven = join(w.root, 'driven');
  writeFileSync(
    join(graph, 'plugins/selected.ts'),
    `
import { writeFileSync } from 'node:fs';
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'selected', tracker: host => {
  writeFileSync(${JSON.stringify(selected)}, import.meta.dirname);
  return folder.tracker(host);
} };`
  );
  const config = join(w.root, 'config.ts');
  writeFileSync(
    config,
    `import { writeFileSync } from 'node:fs';
import { opencode } from ${JSON.stringify(new URL('../harnesses/opencode.ts', import.meta.url).href)};
export default { harnesses: [opencode()], providers: [{ name: 'scoped', harnesses: ['opencode'], ready: () => true,
  settings: ({ env }) => { writeFileSync(${JSON.stringify(driven)}, env.AGENTGRAPH_DIR); return {}; } }] };`
  );
  git(w.seed, 'add', '.agentgraph');
  git(w.seed, 'commit', '-qm', 'graph');
  const leaked = join(w.root, 'leaked');
  writeFileSync(
    join(graph, 'plugins/uncommitted.ts'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(leaked)}, 'leaked'); throw new Error('uncommitted plugin');`
  );
  w.save({ graph: undefined, tracker: 'selected', provider: 'scoped' });
  const result = w.runWithEnv({ AGENTGRAPH_CONFIG: config }, 'loop', '--once');
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  expect(existsSync(leaked)).toBe(false);
  expect(readFileSync(selected, 'utf8')).toBe(realpathSync(join(readFileSync(driven, 'utf8'), 'plugins')));
  expect(readFileSync(driven, 'utf8')).not.toBe(graph);
});

it('does not discover graph plugins for stored-data commands', async () => {
  const w = await makeInstance('stored');
  w.save({ tracker: 'unreviewed' });
  const marker = join(w.root, 'imported');
  mkdirSync(join(w.graph, 'plugins'));
  writeFileSync(
    join(w.graph, 'plugins/unreviewed.ts'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'imported'); throw new Error('unexpected import');`
  );
  const shown = w.run('show');
  const pruned = w.run('prune-logs');
  expect([shown.status, pruned.status]).toEqual([0, 0]);
  expect(existsSync(marker)).toBe(false);
});

const PREFLIGHT = ['local', 'remote'] as const;
it.each(PREFLIGHT)('uses scoped provider and %s sandbox settings in CLI preflight', async sandbox => {
  const w = await makeInstance('preflight');
  const file = join(w.root, 'keys.env');
  writeFileSync(
    file,
    `ANTHROPIC_API_KEY=only-in-file\n${sandbox === 'remote' ? 'AGENTGRAPH_SANDBOX_URL=http://unused\n' : ''}`
  );
  w.save({ env: file, provider: 'anthropic' });
  writeFileSync(join(w.graph, 'settings.yaml'), 'image: sandbox:scoped\n');
  const bin = join(w.root, 'bin');
  const calls = join(w.root, 'docker-calls');
  mkdirSync(bin);
  writeFileSync(
    join(bin, 'docker'),
    `#!/bin/sh
printf '%s\\n' "$*" >> '${calls}'
printf egress
`,
    { mode: 0o755 }
  );
  const result = w.runWithEnv(
    { PATH: `${bin}:${process.env.PATH}`, AGENTGRAPH_SANDBOX_URL: undefined },
    'loop',
    '--once'
  );
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  const invoked = existsSync(calls) ? readFileSync(calls, 'utf8') : '';
  expect(invoked.includes('ps -q')).toBe(false);
  expect(invoked.includes('agentgraph-sandbox:local')).toBe(false);
  expect(invoked.includes('version --format')).toBe(sandbox === 'local');
});

const LOG_OVERRIDES = [
  ['off', 'all'],
  ['all', 'off'],
] as const;
it.each(LOG_OVERRIDES)('--logs %s overrides environment value %s through execution', async (flag, env) => {
  const w = await makeInstance('logs');
  const file = join(w.root, 'keys.env');
  writeFileSync(file, `ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_CHECK_LOGS=${env}\n`);
  w.save({ env: file, provider: 'anthropic' });
  const saved = join(w.root, 'log-choice');
  mkdirSync(join(w.graph, 'plugins'));
  writeFileSync(
    join(w.graph, 'plugins/logs.ts'),
    `
import { writeFileSync } from 'node:fs';
import { Effect, Layer } from ${JSON.stringify(import.meta.resolve('effect'))};
import { settings } from ${JSON.stringify(new URL('../src/services.ts', import.meta.url).href)};
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'logs', tracker: host => { const setup = folder.tracker(host); return { ...setup,
layer: (trust, as) => Layer.unwrap(Effect.map(settings, s => {
  writeFileSync(${JSON.stringify(saved)}, s.checkLogs); return setup.layer(trust, as);
})) }; } };`
  );
  const result = w.runWithEnv({ AGENTGRAPH_CHECK_LOGS: env }, 'loop', '--once', '--tracker', 'logs', '--logs', flag);
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  expect(readFileSync(saved, 'utf8')).toBe(flag);
});

it('compresses idle ended runs during a CLI loop pass', async () => {
  const w = await makeInstance('compress');
  const file = join(w.root, 'keys.env');
  writeFileSync(file, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_COMPRESS_DAYS=1\n');
  w.save({ env: file, provider: 'anthropic' });
  const old = new Date(Date.now() - 30 * 86_400_000);
  const run = {
    ...begin(makeTestGraph('kit').workflows.issue!, {
      id: 'ended',
      issue: 1,
      started: old.toISOString(),
    }),
    status: 'done' as const,
    ended: old.toISOString(),
  };
  await Effect.runPromise(Effect.flatMap(Store, s => s.put(run)).pipe(Effect.provide(fileStore(w.instance.data))));
  const trace = join(w.instance.data, run.id, 'trace.jsonl');
  writeFileSync(trace, '{}\n');
  utimesSync(trace, old, old);
  writeFileSync(join(w.seed, 'README.md'), 'updated base\n');
  git(w.seed, 'add', 'README.md');
  git(w.seed, 'commit', '-qm', 'advance base');
  const result = w.run('loop', '--once');
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  expect([existsSync(trace), existsSync(`${trace}.zst`)]).toEqual([false, true]);
  expect(git(w.seed, '--git-dir', join(w.instance.tracker, 'origin.git'), 'rev-parse', 'main')).toBe(
    git(w.seed, 'rev-parse', 'main')
  );
});

const STUDIO_PATHS = ['record', 'env', 'explicit'] as const;
it.each(STUDIO_PATHS)(
  'refreshes studio graph and watch roots after a %s path change',
  async from => {
    const w = await makeInstance('studio-path');
    const other = join(w.root, 'other-graph');
    mkdirSync(other);
    writeFileSync(join(other, 'settings.yaml'), 'image: sandbox:other\n');
    const env = join(w.root, 'studio.env');
    writeFileSync(env, '');
    w.save({ env });
    vi.stubEnv(
      'AGI_STUDIO_INSTANCES',
      JSON.stringify({ root: w.root, names: ['studio-path'], ...(from === 'explicit' && { graph: w.graph }) })
    );
    vi.stubEnv('AGI_STUDIO_BENCH', undefined);
    vi.stubEnv('AGI_STUDIO_TUNE', undefined);
    const served = makeServedGraphs();
    const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
    const server = await createServer({
      configFile: false,
      root: w.instance.data,
      cacheDir: join(w.root, 'vite'),
      plugins: [makeStudioPagesPlugin(served)],
      server: { middlewareMode: true },
      optimizeDeps: { noDiscovery: true },
      logLevel: 'silent',
    });
    const sent: unknown[] = [];
    server.ws.send = (...args: unknown[]) => void sent.push(args);
    try {
      expect((await served.read())[0]?.dir).toBe(w.graph);
      await vi.waitFor(
        async () => {
          if (from === 'env') writeFileSync(env, `AGENTGRAPH_DIR=${other}\n`);
          else w.save({ graph: other, env });
          server.watcher.emit(
            'all',
            'change',
            realpathSync(from === 'env' ? env : join(w.instance.dir, 'instance.yaml'))
          );
          expect(sent).toContainEqual([{ type: 'full-reload' }]);
          expect((await served.read())[0]?.dir).toBe(from === 'explicit' ? w.graph : other);
        },
        { timeout: 5000, interval: 350 }
      );
      sent.length = 0;
      const watched = from === 'explicit' ? w.graph : other;
      await vi.waitFor(
        async () => {
          writeFileSync(join(watched, 'settings.yaml'), 'image: sandbox:changed\n');
          server.watcher.emit('all', 'change', realpathSync(join(watched, 'settings.yaml')));
          expect((await served.read())[0]?.graph?.image).toBe('sandbox:changed');
          expect(sent).toContainEqual([{ type: 'full-reload' }]);
        },
        { timeout: 5000, interval: 250 }
      );
      expect(server.config.server.fs.allow).not.toContain(env);
    } finally {
      await server.close();
      vi.unstubAllEnvs();
    }
  },
  15_000
);

it('does not import working graph plugins for an origin-less GitHub instance', async () => {
  const w = await makeInstance('remote-snapshot');
  const graph = join(w.seed, '.agentgraph');
  mkdirSync(graph);
  writeFileSync(join(graph, 'settings.yaml'), '{}');
  git(w.seed, 'add', '.agentgraph');
  git(w.seed, 'commit', '-qm', 'graph');
  const marker = join(w.root, 'uncommitted');
  mkdirSync(join(graph, 'plugins'));
  writeFileSync(
    join(graph, 'plugins/unreviewed.ts'),
    `import { writeFileSync } from 'node:fs';
writeFileSync(${JSON.stringify(marker)}, 'imported'); throw new Error('unreviewed plugin');`
  );
  const env = join(w.root, 'app.env');
  writeFileSync(env, 'AGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_KEY=offline-key\n');
  w.save({ graph: undefined, tracker: 'github', env });
  rmSync(w.instance.tracker, { recursive: true });
  const checked = w.run('check');
  expect([checked.status, checked.stdout.trim(), checked.stderr]).toEqual([
    0,
    'ok',
    expect.stringContaining('committed version on main'),
  ]);
  expect(existsSync(marker)).toBe(false);
  symlinkSync('../README.md', join(graph, 'leak.md'));
  git(w.seed, 'add', '.agentgraph/leak.md');
  git(w.seed, 'commit', '-qm', 'link');
  const rejected = w.run('check');
  expect([rejected.status, rejected.stderr]).toEqual([1, expect.stringContaining('links or submodules')]);
  w.save({ graph: undefined, tracker: 'github', env, base: 'absent' });
  expect(w.run('check').status).toBe(1);
  expect(existsSync(marker)).toBe(false);
});

it('prints the startup banner for an origin-less instance with a committed graph', async () => {
  const w = await makeInstance('banner');
  const graph = join(w.seed, '.agentgraph');
  mkdirSync(graph);
  writeFileSync(join(graph, 'settings.yaml'), '{}');
  git(w.seed, 'add', '.agentgraph');
  git(w.seed, 'commit', '-qm', 'graph');
  const env = join(w.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_KEY=offline-key\n');
  w.save({ graph: undefined, tracker: 'github', env, provider: 'anthropic' });
  rmSync(w.instance.tracker, { recursive: true });
  const result = w.run('loop', '--once');
  expect(result.stdout).toMatch(/\.agentgraph\/ at main [0-9a-f]{7}, /);
});

it('prints the banner without a revision when the graph source cannot be read', async () => {
  const w = await makeInstance('unread');
  rmSync(w.instance.tracker, { recursive: true });
  const graph = getCachePath(w.instance.data, 'graphs', 'tree');
  const names = await Promise.all([
    formatGraphName({ ...w.instance, base: 'absent' }, graph),
    formatGraphName({ ...w.instance, checkout: w.root }, graph),
  ]);
  expect(names).toEqual(['.agentgraph/ at absent', '.agentgraph/ at main']);
});

it('starts the hosted entrypoint from a non-repo image with its named instance', async () => {
  const w = await makeInstance('live');
  const env = join(w.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\n');
  w.save({ env, provider: 'anthropic' });
  const image = join(w.root, 'image');
  const entry = join(image, 'examples/deploy/engine');
  mkdirSync(entry, { recursive: true });
  cpSync(new URL('../examples/deploy/engine/start.sh', import.meta.url), join(entry, 'start.sh'));
  symlinkSync(new URL('../bin', import.meta.url), join(image, 'bin'));
  const commands = join(w.root, 'commands');
  mkdirSync(commands);
  const args = join(w.root, 'args');
  writeFileSync(
    join(commands, 'node'),
    `#!/bin/sh
printf '%s\\n' "$@" > "$STARTUP_ARGS"
exec "$NODE_EXECUTABLE" "$@" --once
`,
    { mode: 0o755 }
  );
  const environment = {
    PATH: `${commands}:${process.env.PATH}`,
    NODE_OPTIONS: '',
    NODE_EXECUTABLE: process.execPath,
    STARTUP_ARGS: args,
    AGENTGRAPH_DATA: w.root,
    AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
    AGENTGRAPH_SANDBOX_URL: 'http://unused',
  };
  const result = spawnSync('sh', [join(entry, 'start.sh')], { encoding: 'utf8', env: environment });
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  expect(readFileSync(args, 'utf8').trim().split('\n')).toEqual([
    'bin/run.ts',
    'loop',
    '--instance',
    'live',
    '--data',
    w.root,
  ]);
  rmSync(join(w.instance.dir, 'instance.yaml'));
  rmSync(args);
  const missing = spawnSync('sh', [join(entry, 'start.sh')], { encoding: 'utf8', env: environment });
  expect([missing.status, missing.stderr]).toEqual([1, expect.stringContaining('provision')]);
  expect(existsSync(args)).toBe(false);
  expect(readFileSync(new URL('../examples/deploy/cloudflare/engine.sh', import.meta.url), 'utf8')).toContain(
    'loop --instance live --data'
  );
});

it('prepares the selected provider before CLI dispatch', async () => {
  const w = await makeInstance('dispatch');
  const env = join(w.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=only-in-instance\n');
  w.save({ env, provider: 'anthropic' });
  mkdirSync(join(w.graph, 'agents'));
  writeFileSync(join(w.graph, 'agents/a.md'), '---\n---\nRepair');
  mkdirSync(join(w.graph, 'workflows'));
  writeFileSync(join(w.graph, 'workflows/repair.md'), '---\non: issues\nagent: a\n---\n');
  const captured = join(w.root, 'provider-settings');
  mkdirSync(join(w.graph, 'plugins'));
  writeFileSync(
    join(w.graph, 'plugins/selected.ts'),
    `
import { writeFileSync } from 'node:fs';
import { Effect, Layer, Redacted } from ${JSON.stringify(import.meta.resolve('effect'))};
import { settings } from ${JSON.stringify(new URL('../src/services.ts', import.meta.url).href)};
import { readHarnessSettings } from ${JSON.stringify(new URL('../src/harnesses.ts', import.meta.url).href)};
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'selected', tracker: host => { const setup = folder.tracker(host); return { ...setup,
layer: (trust, as) => Layer.unwrap(Effect.map(Effect.all({ settings, harness: readHarnessSettings }), ({ settings: s, harness }) => {
  writeFileSync(${JSON.stringify(captured)}, JSON.stringify({ proxy: s.proxy.url, key: s.passed.ANTHROPIC_API_KEY ? Redacted.value(s.passed.ANTHROPIC_API_KEY) : undefined, provider: harness.provider }));
  return setup.layer(trust, as);
})) }; } };`
  );
  await writeIssueFile(w.instance.tracker, { title: 'Repair', author: 'owner', labels: [] }, '');
  const result = w.run('dispatch', '1', '--workflow', 'repair', '--tracker', 'selected');
  expect([result.status, result.stderr]).toEqual([0, expect.not.stringContaining('Error')]);
  expect(JSON.parse(readFileSync(captured, 'utf8'))).toEqual({
    proxy: 'claude=',
    key: 'only-in-instance',
    provider: 'anthropic',
  });
});

it('releases the loop lock on SIGTERM before a replacement starts', async () => {
  const w = await makeInstance('terminate');
  const env = join(w.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_EVERY=60\n');
  w.save({ env, provider: 'anthropic' });
  const ready = join(w.root, 'loop-ready');
  mkdirSync(join(w.graph, 'plugins'));
  writeFileSync(
    join(w.graph, 'plugins/ready.ts'),
    `
import { writeFileSync } from 'node:fs';
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'ready', tracker: host => { const setup = folder.tracker(host); return { ...setup,
layer: (trust, as) => { writeFileSync(${JSON.stringify(ready)}, 'ready'); return setup.layer(trust, as); }
}; } };`
  );
  const child = spawn(
    process.execPath,
    [cli, 'loop', '--instance', 'terminate', '--data', w.root, '--tracker', 'ready'],
    {
      cwd: w.root,
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '',
        AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
        AGENTGRAPH_SANDBOX_URL: 'http://unused',
      },
    }
  );
  let exited: [typeof child.exitCode, typeof child.signalCode] | undefined;
  child.once('exit', (code, signal) => {
    exited = [code, signal];
  });
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 20_000 });
    child.kill('SIGTERM');
    await vi.waitFor(() => expect(exited).toEqual([143, null]), { timeout: 5000 });
    const release = await createLoopLock(w.instance.data);
    await release();
    const replacement = w.run('loop', '--once', '--tracker', 'ready');
    expect([replacement.status, replacement.stderr]).toEqual([0, expect.not.stringContaining('another loop holds')]);
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

it('keeps the last settings when the instance env vanishes between passes, then still releases its lock', async () => {
  const w = await makeInstance('rotate');
  const env = join(w.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_EVERY=0.002\n');
  w.save({ env, provider: 'anthropic' });
  const ready = join(w.root, 'loop-ready');
  mkdirSync(join(w.graph, 'plugins'));
  writeFileSync(
    join(w.graph, 'plugins/ready.ts'),
    `
import { writeFileSync } from 'node:fs';
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'ready', tracker: host => { const setup = folder.tracker(host); return { ...setup,
layer: (trust, as) => { writeFileSync(${JSON.stringify(ready)}, 'ready'); return setup.layer(trust, as); }
}; } };`
  );
  const child = spawn(process.execPath, [cli, 'loop', '--instance', 'rotate', '--data', w.root, '--tracker', 'ready'], {
    cwd: w.root,
    stdio: 'pipe',
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '',
      AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
      AGENTGRAPH_SANDBOX_URL: 'http://unused',
    },
  });
  let output = '';
  child.stderr.on('data', chunk => (output += chunk));
  let exited: [typeof child.exitCode, typeof child.signalCode] | undefined;
  child.once('exit', (code, signal) => {
    exited = [code, signal];
  });
  try {
    await vi.waitFor(() => expect(existsSync(ready)).toBe(true), { timeout: 20_000 });
    rmSync(env);
    await vi.waitFor(() => expect(output).toContain('the settings did not refresh, the next pass keeps the last'), {
      timeout: 20_000,
    });
    expect(exited).toBeUndefined();
    child.kill('SIGTERM');
    await vi.waitFor(() => expect(exited).toEqual([143, null]), { timeout: 5000 });
    await (
      await createLoopLock(w.instance.data)
    )();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

const makeInstances = async (names: string[]) => {
  const w = await makeInstance(names[0]!);
  const env = join(w.root, 'model.env');
  writeFileSync(env, 'ANTHROPIC_API_KEY=scoped\nAGENTGRAPH_EVERY=60\n');
  const graphs = await Promise.all(
    names.map(async name => {
      const graph = join(w.root, `graph-${name}`);
      const ready = join(w.root, `ready-${name}`);
      mkdirSync(join(graph, 'plugins'), { recursive: true });
      writeFileSync(join(graph, 'settings.yaml'), '{}');
      writeFileSync(
        join(graph, 'plugins/ready.ts'),
        `
import { writeFileSync } from 'node:fs';
import { folder } from ${JSON.stringify(new URL('../src/tracker.ts', import.meta.url).href)};
export default { name: 'ready', tracker: host => { const setup = folder.tracker(host); return { ...setup,
layer: (trust, as) => { writeFileSync(${JSON.stringify(ready)}, 'ready'); return setup.layer(trust, as); }
}; } };`
      );
      const instance = await ensureInstance(w.root, name, w.seed);
      writeFileSync(
        join(instance.dir, 'instance.yaml'),
        stringify({
          checkout: w.seed,
          base: 'main',
          owner: 'owner',
          exported: {},
          loop: true,
          graph,
          env,
          provider: 'anthropic',
          tracker: 'ready',
        })
      );
      return { name, graph, ready, data: instance.data };
    })
  );
  const spawnLoop = (...args: string[]) =>
    spawn(process.execPath, [cli, 'loop', '--data', w.root, ...args], {
      cwd: w.root,
      stdio: 'pipe',
      env: {
        PATH: process.env.PATH,
        NODE_OPTIONS: '',
        AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
        AGENTGRAPH_SANDBOX_URL: 'http://unused',
      },
    });
  return { ...w, graphs, spawnLoop };
};

it('serves every loop instance in one process and keeps going when one fails to start', async () => {
  const w = await makeInstances(['first', 'second', 'broken']);
  rmSync(w.graphs[2]!.graph, { recursive: true });
  const result = spawnSync(process.execPath, [cli, 'loop', '--once', '--data', w.root], {
    cwd: w.root,
    encoding: 'utf8',
    env: {
      PATH: process.env.PATH,
      NODE_OPTIONS: '',
      AGENTGRAPH_STATE: process.env.AGENTGRAPH_STATE,
      AGENTGRAPH_SANDBOX_URL: 'http://unused',
    },
  });
  expect([
    result.status,
    result.stdout,
    result.stderr,
    w.graphs.map(g => existsSync(g.ready)),
    w.graphs.map(g => existsSync(join(g.data, '.locks', 'loop.lock'))),
  ]).toEqual([
    1,
    expect.stringMatching(/^(?=[^]*^first: agentgraph )(?=[^]*^second: agentgraph )/m),
    expect.stringContaining('broken: stopped: no graph found'),
    [true, true, false],
    [false, false, false],
  ]);
  const flags = ['repo', 'dir', 'base', 'tracker'];
  const refused = flags.map(flag =>
    spawnSync(
      process.execPath,
      [cli, 'loop', '--data', w.root, '--instance', 'first', '--instance', 'second', `--${flag}`, w.seed],
      {
        encoding: 'utf8',
        cwd: w.root,
      }
    )
  );
  expect(refused.map(r => [r.status, r.stderr.trim()])).toEqual(
    flags.map(flag => [2, `--${flag} applies to one instance; set it in each instance.yaml`])
  );
});

it('releases the lock of every served instance on SIGTERM', async () => {
  const w = await makeInstances(['left', 'right']);
  const child = w.spawnLoop('--instance', 'left', '--instance', 'right', '--parallel', '1');
  let exited: [typeof child.exitCode, typeof child.signalCode] | undefined;
  child.once('exit', (code, signal) => {
    exited = [code, signal];
  });
  try {
    await vi.waitFor(() => expect(w.graphs.map(g => existsSync(g.ready))).toEqual([true, true]), { timeout: 20_000 });
    child.kill('SIGTERM');
    await vi.waitFor(() => expect(exited).toEqual([143, null]), { timeout: 5000 });
    for (const release of await Promise.all(w.graphs.map(g => createLoopLock(g.data)))) await release();
  } finally {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL');
  }
});

it('invalidates loaded virtual pages when switching graphs and removing a plugin', async () => {
  const w = await makeInstance('pages');
  const other = join(w.root, 'other-pages');
  mkdirSync(other);
  writeFileSync(join(other, 'settings.yaml'), '{}');
  const sdk = JSON.stringify(new URL('../src/plugin.ts', import.meta.url).href);
  for (const [graph, name] of [
    [w.graph, 'A'],
    [other, 'B'],
  ]) {
    mkdirSync(join(graph!, 'plugins/pages'), { recursive: true });
    writeFileSync(join(graph!, 'plugins/pages', `${name}.tsx`), 'export default function Page() { return null; }');
    writeFileSync(
      join(graph!, 'plugins/count.ts'),
      `
import { makePlugin } from ${sdk};
import { Effect, Schema } from ${JSON.stringify(import.meta.resolve('effect'))};
export default makePlugin({ name: 'count', studio: { title: 'Count',
  page: new URL('./pages/${name}.tsx', import.meta.url), dataSchema: Schema.String,
  read: () => Effect.succeed('${name}') } });`
    );
  }
  vi.stubEnv('AGI_STUDIO_INSTANCES', JSON.stringify({ root: w.root, names: ['pages'] }));
  vi.stubEnv('AGI_STUDIO_BENCH', undefined);
  vi.stubEnv('AGI_STUDIO_TUNE', undefined);
  const { createServer } = await import(pathToFileURL(join(studioDir, 'node_modules/vite/dist/node/index.js')).href);
  const server = await createServer({
    configFile: false,
    root: w.instance.data,
    cacheDir: join(w.root, 'vite'),
    plugins: [makeStudioPagesPlugin()],
    server: { middlewareMode: true },
    optimizeDeps: { noDiscovery: true },
    logLevel: 'silent',
  });
  const sent: unknown[] = [];
  server.ws.send = (...args: unknown[]) => void sent.push(args);
  const page = 'virtual:agentgraph-page/pages/count';
  try {
    expect((await server.transformRequest(page))?.code).toContain('/A.tsx');
    w.save({ graph: other });
    server.watcher.emit('all', 'change', realpathSync(join(w.instance.dir, 'instance.yaml')));
    await vi.waitFor(() => expect(sent).toContainEqual([{ type: 'full-reload' }]), { timeout: 5000 });
    expect((await server.transformRequest(page))?.code).toContain('/B.tsx');
    sent.length = 0;
    rmSync(join(other, 'plugins/count.ts'));
    server.watcher.emit('all', 'unlink', realpathSync(other) + '/plugins/count.ts');
    await vi.waitFor(() => expect(sent).toContainEqual([{ type: 'full-reload' }]), { timeout: 5000 });
    expect(server.moduleGraph.getModuleById('\0virtual:agentgraph-page/pages/count')?.transformResult).toBeNull();
    await expect(server.transformRequest(page)).rejects.toThrow();
  } finally {
    await server.close();
    vi.unstubAllEnvs();
  }
});
