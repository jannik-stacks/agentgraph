import { join } from 'node:path';
import { ConfigProvider, Effect, Either, Redacted } from 'effect';
import { expect, it } from 'vitest';
import { makeProductionLayers, pickTracker, readHostSettings, settings } from '../src/services.ts';
import { Tracker, writeIssueFile } from '../src/tracker.ts';
import { tmp, write } from './kit.ts';

const read = (name: string) =>
  Effect.runPromise(
    Effect.either(settings).pipe(
      Effect.withConfigProvider(
        ConfigProvider.fromMap(
          new Map([
            ['AGENTGRAPH_REPO', 'owner/repository'],
            ['AGENTGRAPH_TRACKER', '/tracker'],
            ['AGENTGRAPH_SESSION_ENV', name],
            [name, 'private-value'],
          ])
        )
      )
    )
  );

it.each(['AGENTGRAPH_TOOL_SECRET', 'AGENTGRAPH_APP_KEY', 'GH_TOKEN', 'PLUGIN_PASSWORD', 'UNREVIEWED_VALUE'])(
  'refuses forwarding %s to sessions',
  async name => {
    const result = await read(name);
    expect(Either.isLeft(result)).toBe(true);
    expect(String(Either.getLeft(result))).toContain('may list only model login variables');
  }
);

it.each(['CLAUDE_CODE_OAUTH_TOKEN', 'ANTHROPIC_API_KEY', 'AGENTGRAPH_CHATGPT_AUTH', 'OPENCODE_AUTH_CONTENT'])(
  'still forwards model authentication through %s',
  async name => {
    const result = await read(name);
    expect(Either.isRight(result)).toBe(true);
    expect(Redacted.value(Either.getOrThrow(result).passed[name]!)).toBe('private-value');
  }
);

it('picks a tracker plugin by name, else a tracker folder at the path, and fails on neither', async () => {
  const [mine, other, graph] = [tmp('mine'), tmp('other'), tmp('graph')];
  await writeIssueFile(mine, { title: 'from mine', author: 'alice', labels: [] }, '');
  await writeIssueFile(other, { title: 'from the folder', author: 'alice', labels: [] }, '');
  const tracker = JSON.stringify(join(import.meta.dirname, '..', 'src', 'tracker.ts'));
  write(graph, {
    'plugins/mine.ts': `import { folder } from ${tracker};
export default { name: 'mine', tracker: host => folder.tracker({ ...host, dir: ${JSON.stringify(mine)} }) };
`,
  });
  const titles = (vars: Record<string, string>) => {
    const s = Effect.runSync(
      settings.pipe(
        Effect.withConfigProvider(
          ConfigProvider.fromMap(
            new Map(
              Object.entries({ AGENTGRAPH_REPO: 'o/r', AGENTGRAPH_TRUST: 'alice', AGENTGRAPH_DIR: graph, ...vars })
            )
          )
        )
      )
    );
    const issues = Effect.flatMap(Tracker, t => t.issues());
    return Effect.runPromise(Effect.provide(issues, makeProductionLayers()(s))).then(all => all.map(i => i.title));
  };
  expect(await titles({ AGENTGRAPH_TRACKER: 'mine' })).toEqual(['from mine']);
  expect(await titles({ AGENTGRAPH_TRACKER: other })).toEqual(['from the folder']);
  await expect(titles({ AGENTGRAPH_TRACKER: 'nope' })).rejects.toThrow(
    /no tracker plugin nope .*trackers: github, folder, mine/
  );
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
