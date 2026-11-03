import { join } from 'node:path';
import { ConfigProvider, Effect, Either, Redacted } from 'effect';
import { expect, it } from 'vitest';
import { makeProductionLayers, settings } from '../src/services.ts';
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
    /no tracker plugin nope .*plugins: github, folder, mine/
  );
});
