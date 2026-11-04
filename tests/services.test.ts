import { join } from 'node:path';
import { ConfigProvider, Effect, Option, Result, Redacted } from 'effect';
import { afterEach, expect, it, vi } from 'vitest';
import { makeEnvProvider } from '../src/harnesses.ts';
import { makeProductionLayers, makeTrackerSetup, pickTracker, readHostSettings, settings } from '../src/services.ts';
import { Tracker, writeIssueFile } from '../src/tracker.ts';
import { tmp, write } from './kit.ts';

const read = (name: string) =>
  Effect.runPromise(
    Effect.result(settings).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        ConfigProvider.fromEnv({
          env: Object.fromEntries([
            ['AGENTGRAPH_REPO', 'owner/repository'],
            ['AGENTGRAPH_TRACKER', '/tracker'],
            ['AGENTGRAPH_SESSION_ENV', name],
            [name, 'private-value'],
          ]),
        })
      )
    )
  );

it.each(['AGENTGRAPH_TOOL_SECRET', 'AGENTGRAPH_APP_KEY', 'GH_TOKEN', 'PLUGIN_PASSWORD', 'UNREVIEWED_VALUE'])(
  'refuses forwarding %s to sessions',
  async name => {
    const result = await read(name);
    expect(Result.isFailure(result)).toBe(true);
    expect(String(Result.getFailure(result))).toContain('may list only model login variables');
  }
);

it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AGENTGRAPH_CHATGPT_AUTH', 'OPENCODE_AUTH_CONTENT'])(
  'still forwards model authentication through %s',
  async name => {
    const result = await read(name);
    expect(Result.isSuccess(result)).toBe(true);
    expect(Redacted.value(Result.getOrThrow(result).passed[name]!)).toBe('private-value');
  }
);

it('picks a tracker plugin by name, else a tracker folder at the path, and fails on neither', async () => {
  const [mine, other, graph] = [tmp('mine'), tmp('other'), tmp('graph')];
  await writeIssueFile(mine, { title: 'from mine', author: 'alice', labels: [] }, '');
  await writeIssueFile(other, { title: 'from the folder', author: 'alice', labels: [] }, '');
  const tracker = JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'));
  write(graph, {
    'plugins/mine.ts': `import { folder } from ${tracker};
export default { ...folder, name: 'mine' };
`,
  });
  const titles = (vars: Record<string, string>) => {
    const s = Effect.runSync(
      settings.pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({
            env: { AGENTGRAPH_REPO: 'o/r', AGENTGRAPH_TRUST: 'alice', AGENTGRAPH_DIR: graph, ...vars },
          })
        )
      )
    );
    const issues = Effect.flatMap(Tracker, t => t.issues());
    return Effect.runPromise(Effect.provide(issues, makeProductionLayers()(s))).then(all => all.map(i => i.title));
  };
  expect(await titles({ AGENTGRAPH_TRACKER: 'mine', AGENTGRAPH_TRACKER_DIR: mine })).toEqual(['from mine']);
  expect(await titles({ AGENTGRAPH_TRACKER: other })).toEqual(['from the folder']);
  await expect(titles({ AGENTGRAPH_TRACKER: 'nope' })).rejects.toThrow(
    /no tracker plugin nope .*trackers: github, folder, mine/
  );
});

it('holds an instance tracker to its folder, refusing a path and a graph whose plugin moved the folder', async () => {
  const [folderDir, other, before, after] = [tmp('instance'), tmp('other'), tmp('graph-a'), tmp('graph-b')];
  const tracker = JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'));
  write(before, {
    'plugins/mine.ts': `import { folder } from ${tracker};\nexport default { ...folder, name: 'mine' };\n`,
  });
  write(after, {
    'plugins/mine.ts': `import { folder } from ${tracker};
export default { name: 'mine', tracker: host => folder.tracker({ ...host, dir: host.dir + '/issues' }) };
`,
  });
  const setup = (graph: string, name: string) =>
    makeTrackerSetup({ repo: 'o/r', studio: '', app: Option.none(), graph, tracker: name, trackerDir: folderDir }).then(
      s => s.origin.origin,
      (e: Error) => e.message
    );
  expect(await Promise.all([setup(before, 'mine'), setup(after, 'mine'), setup(before, other)])).toEqual([
    join(folderDir, 'origin.git'),
    `tracker mine keeps its issues outside ${folderDir}; an instance tracker wraps the folder it is given`,
    `tracker ${other} is a folder; an instance names a tracker plugin, its folder is ${folderDir}`,
  ]);
});

it('says why a tracker selection cannot work, reading only', async () => {
  const graph = tmp('graph');
  const tracker = JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'));
  write(graph, {
    'plugins/mine.ts': `import { folder } from ${tracker};
export default { name: 'mine', tracker: host => folder.tracker({ ...host, dir: '/nowhere' }) };
`,
    'plugins/board.ts': `export default { name: 'board', on: { status: async () => {} } };
`,
  });
  const problem = async (name: string, fromRepo = false) => {
    const picked = await pickTracker(name, { dir: graph, fromRepo });
    return 'problem' in picked ? picked.problem : undefined;
  };
  expect(await problem('mine')).toBeUndefined();
  expect(await problem('')).toMatch(/^name a tracker/);
  expect(await problem('github', true)).toBeUndefined();
  expect(await problem('board')).toBe('plugin board has no tracker');
  expect(await problem('mine', true)).toMatch(/^tracker mine is a plugin of a graph read from the repo/);
  expect(await problem('__nope__')).toMatch(/^no tracker plugin __nope__ and no folder .*__nope__; trackers: /);
});

it('selects the tracker once: the flag, else AGENTGRAPH_TRACKER, else github when the App env is set', async () => {
  const names = [
    'AGENTGRAPH_TRACKER',
    'AGENTGRAPH_APP_ID',
    'AGENTGRAPH_APP_ENV',
    'AGENTGRAPH_APP_KEY',
    'AGENTGRAPH_APP_KEY_FILE',
  ];
  const saved = names.map(name => process.env[name]);
  const pick = async (env: Record<string, string>, flag?: string) => {
    for (const name of names) delete process.env[name];
    Object.assign(process.env, env);
    return (await readHostSettings(flag === undefined ? {} : { tracker: flag })).tracker;
  };
  try {
    expect(await pick({})).toBeUndefined();
    expect(await pick({ AGENTGRAPH_TRACKER: '' })).toBeUndefined();
    expect(await pick({ AGENTGRAPH_TRACKER: 'mine' })).toBe('mine');
    expect(await pick({ AGENTGRAPH_APP_ID: '1' })).toBe('github');
    expect(await pick({ AGENTGRAPH_APP_ID: '1', AGENTGRAPH_TRACKER: '/tracker' })).toBe('/tracker');
    expect(await pick({ AGENTGRAPH_TRACKER: 'mine' }, 'folder-flag')).toBe('folder-flag');
  } finally {
    names.forEach((name, i) => (saved[i] === undefined ? delete process.env[name] : (process.env[name] = saved[i])));
  }
});

const readWith = (env: Record<string, string>) =>
  Effect.runPromise(
    Effect.result(settings).pipe(
      Effect.provideService(
        ConfigProvider.ConfigProvider,
        makeEnvProvider({ AGENTGRAPH_REPO: 'owner/repository', AGENTGRAPH_TRACKER: '/tracker', ...env })
      )
    )
  );

it.each([
  ['an empty trust list trusts no one instead of the graph list', { AGENTGRAPH_TRUST: '' }, { trust: [''] }],
  ['trusted logins are trimmed', { AGENTGRAPH_TRUST: 'alice, bob ,carol' }, { trust: ['alice', 'bob', 'carol'] }],
  ['an empty cache volume disables the cache', { AGENTGRAPH_CACHE_VOLUME: '' }, { cache: '' }],
  ['unset settings take their defaults', {}, { trust: [], cache: 'agentgraph-cache', checkLogs: 'all' }],
  ['numbers are trimmed', { AGENTGRAPH_EVERY: ' 3 ', AGENTGRAPH_COMPRESS_DAYS: ' 7' }, { every: 3, compress: 7 }],
  ['an empty compress setting is 0, never', { AGENTGRAPH_COMPRESS_DAYS: '' }, { compress: 0 }],
  ['no tracker and no App env read as no tracker name', { AGENTGRAPH_TRACKER: '' }, { tracker: '' }],
])('%s', async (_name, env, expected) => {
  expect(Result.getOrThrow(await readWith(env))).toMatchObject(expected);
});

it.each([
  ['AGENTGRAPH_CHECK_LOGS', ''],
  ['AGENTGRAPH_COMPRESS_DAYS', 'NaN'],
  ['AGENTGRAPH_EVERY', ''],
])('refuses %s=%j and names it', async (name, value) => {
  const result = await readWith({ [name]: value });
  expect(Result.isFailure(result)).toBe(true);
  expect(JSON.stringify(Result.getFailure(result))).toContain(name);
});

afterEach(() => vi.unstubAllEnvs());

it('reads host settings from the environment, keeping empty values and naming a bad number', async () => {
  vi.stubEnv('AGENTGRAPH_COMPRESS_DAYS', 'NaN');
  await expect(readHostSettings({ data: '/data' })).rejects.toThrow('AGENTGRAPH_COMPRESS_DAYS');
  vi.stubEnv('AGENTGRAPH_COMPRESS_DAYS', '');
  expect(await readHostSettings({ data: '/data' })).toMatchObject({ compress: 0 });
});

it('reads an unset tracker as no tracker name, which pickTracker refuses', async () => {
  const result = await Effect.runPromise(
    Effect.result(settings).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, makeEnvProvider({ AGENTGRAPH_REPO: 'owner/repository' }))
    )
  );
  expect(Result.getOrThrow(result).tracker).toBe('');
});
