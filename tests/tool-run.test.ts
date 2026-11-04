import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { join } from 'node:path';
import { ConfigProvider, Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { runWorkflow } from '../src/run/drive.ts';
import { loadGraph } from '../src/folder.ts';
import { folderTracker } from '../src/tracker.ts';
import { Session } from '../src/session.ts';
import { fileStore } from '../src/store.ts';
import type { SessionSpec } from '../src/trace.ts';
import { begin } from '../src/workflow.ts';
import { readLocalHttp } from './doubles/http.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { reply, start } from './fixtures.ts';
import { write } from './kit.ts';
import { readTrace, world } from './world.ts';

describe('custom tools in a run', () => {
  it('calls the selected host tool and traces it once without exposing its session secret', async () => {
    const where = world();
    const dir = join(where.root, 'graph');
    write(dir, {
      'settings.yaml': '{}',
      'agents/triager.md': '---\nharness: test\ntools: [issues]\n---\nSearch before commenting.\n',
      'workflows/triage.md': '---\non: issues\nagent: triager\n---\nFind related issues.\n',
      'plugins/issues.ts': `import { makePlugin, tool } from '${new URL('../src/plugin.ts', import.meta.url).href}';
import { Schema } from '${import.meta.resolve('effect')}';
const search = tool({
  description: 'Search this repository',
  inputSchema: Schema.Struct({ query: Schema.String }),
  execute: async ({ query }, ctx) => ({
    repo: ctx.repo,
    issues: (await ctx.tracker.searchIssues(query, { state: 'all' })).map(issue => issue.number),
  }),
});
export default makePlugin({ name: 'search', tools: { issues: search, private: search } });
`,
    });
    write(join(where.root, 'other-tracker'), {
      '99/issue.md':
        '---\ntitle: Another greeting\nstate: open\nauthor: morgan\nlabels: []\n---\nOutside the selected tracker.\n',
    });
    const graph = await Effect.runPromise(
      loadGraph(dir, [{ name: 'test', classify: () => undefined }]).pipe(
        Effect.map(graph => ({ ...graph, repo: 'owner/repository' })),
        Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} }))
      )
    );
    const workflow = graph.workflows.triage!;
    const specs: SessionSpec[] = [];
    const results: unknown[] = [];
    const listed: string[][] = [];
    const session = Layer.succeed(Session, {
      open: spec => {
        specs.push(spec);
        return Stream.concat(
          Stream.make(start('triage-session')),
          Stream.fromEffect(
            Effect.promise(async () => {
              const client = new Client({ name: 'agentgraph-run-test', version: '1.0.0' });
              const endpoint = spec.mcp!;
              try {
                await client.connect(
                  new StreamableHTTPClientTransport(new URL(endpoint.url), {
                    fetch: readLocalHttp,
                    requestInit: { headers: { Authorization: `Bearer ${endpoint.secret}` } },
                  }) as Parameters<Client['connect']>[0]
                );
                listed.push((await client.listTools()).tools.map(tool => tool.name));
                results.push(await client.callTool({ name: 'issues', arguments: { query: 'greeting' } }));
              } finally {
                await client.close();
              }
              return reply({ kind: 'comment', body: 'Found the related issue.' });
            })
          )
        );
      },
    });
    const done = await Effect.runPromise(
      runWorkflow(
        workflow,
        begin(workflow, { id: 'tool-run', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
        graph
      ).pipe(
        Effect.provide(
          Layer.mergeAll(folderTracker(where.tracker), fileStore(where.data), hostSandbox(where.origin), session)
        )
      )
    );
    expect(done.status).toBe('done');
    expect(graph.tools).toEqual(['issues', 'private']);
    expect(listed).toEqual([['issues']]);
    expect(results).toEqual([
      expect.objectContaining({
        content: [{ type: 'text', text: JSON.stringify({ repo: 'owner/repository', issues: [7] }) }],
        isError: false,
      }),
    ]);
    expect(specs[0]!.tools).toEqual([]);
    expect(specs[0]!.mcp!.tools).toEqual(['issues']);
    const trace = readTrace(where.data, 'tool-run');
    const calls = trace.flatMap(line => ('event' in line && line.event.type === 'tool' ? [line] : []));
    expect(calls).toEqual([
      expect.objectContaining({
        at: expect.any(String),
        key: expect.any(String),
        step: 'triage',
        event: expect.objectContaining({
          type: 'tool',
          name: 'issues',
          input: { query: 'greeting' },
          ok: true,
          ms: expect.any(Number),
          output: JSON.stringify({ repo: 'owner/repository', issues: [7] }),
        }),
      }),
    ]);
    const prompt = trace.find(line => 'prompt' in line);
    expect(prompt).toMatchObject({ key: calls[0]!.key, prompt: { tools: ['issues'] } });
    expect(prompt).not.toHaveProperty('prompt.mcp');
    expect(JSON.stringify(trace)).not.toContain(specs[0]!.mcp!.secret);
    expect(JSON.stringify(trace)).not.toContain(specs[0]!.mcp!.url);
    await expect(
      readLocalHttp(specs[0]!.mcp!.url, {
        method: 'POST',
        headers: { Authorization: `Bearer ${specs[0]!.mcp!.secret}` },
      })
    ).rejects.toThrow();
  });
});
