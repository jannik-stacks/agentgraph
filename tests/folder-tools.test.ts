import { mkdir, mkdtemp, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ConfigProvider, Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { loadGraph } from '../src/folder.ts';

const pluginSource = (names = ['issues', 'other']) => `
import { makePlugin, tool } from '${pathToFileURL(join(import.meta.dirname, '../src/plugin.ts')).href}';
import { Schema } from '${import.meta.resolve('effect')}';
export default makePlugin({name:'search',tools:Object.fromEntries(${JSON.stringify(names)}.map(name=>[name,tool({description:'Search issues',inputSchema:Schema.Struct({query:Schema.String}),execute:({query},ctx)=>ctx.tracker.searchIssues(query,{limit:10})})]))});
`;

const makeGraphDir = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentgraph-tool-check-'));
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    })
  );
  return dir;
};

const files = (tools: string[]) => ({
  'agents/a.md': `---\nharness: custom\ntools: ${JSON.stringify(tools)}\n---\n`,
  'workflows/w.md': '---\non: issues\nagent: a\n---\n',
  'plugins/search.ts': pluginSource(),
});

const readGraph = (dir: string, harnesses: Parameters<typeof loadGraph>[1]) =>
  Effect.runPromise(
    loadGraph(dir, harnesses).pipe(
      Effect.provideService(ConfigProvider.ConfigProvider, ConfigProvider.fromEnv({ env: {} }))
    )
  );

describe('agent tools', () => {
  it('still resolves custom tools separately for each agent and checks only harness tools', async () => {
    const check = vi.fn<NonNullable<Parameters<typeof loadGraph>[1][number]['check']>>(() => []);
    const dir = await makeGraphDir({
      ...files(['read', 'issues']),
      'agents/b.md': '---\nharness: custom\ntools: [grep, other]\n---\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a }\n  y: { agent: b }\n---\n',
    });
    const graph = await readGraph(dir, [
      {
        name: 'custom',
        package: 'custom',
        classify: name => (['read', 'grep'].includes(name) ? 'read' : undefined),
        check,
      },
    ]);
    expect(graph.agents.a!.tools).toEqual(['read', 'issues']);
    expect(graph.agents.b!.tools).toEqual(['grep', 'other']);
    expect(check.mock.calls.map(([agent]) => agent.tools)).toEqual([['read'], ['grep']]);
  });

  it('marks an agent whose harness tools only read as readonly', async () => {
    const dir = await makeGraphDir({
      ...files(['read', 'issues']),
      'agents/b.md': '---\nharness: custom\ntools: [read, edit]\n---\n',
      'workflows/w.md': '---\non: issues\nsteps:\n  x: { agent: a }\n  y: { agent: b }\n---\n',
    });
    const graph = await readGraph(dir, [
      {
        name: 'custom',
        package: 'custom',
        classify: name => (name === 'edit' ? 'write' : name === 'read' ? 'read' : undefined),
      },
    ]);
    expect(graph.agents.a!.readonly).toBe(true);
    expect(graph.agents.b!.readonly).toBeUndefined();
  });

  it.each(['missing', 'constructor', 'issues(pattern)'])('reports unknown tool %s plainly', async name => {
    const dir = await makeGraphDir(files(['read', name]));
    await expect(
      readGraph(dir, [{ name: 'custom', package: 'custom', classify: name => (name === 'read' ? 'read' : undefined) }])
    ).rejects.toThrow(`agents/a.md: tools: unknown tool ${name}`);
  });

  it.each([
    ['missing', undefined],
    ['not a function', 'read'],
    ['invalid result', () => 'invalid'],
  ])('rejects a classifier that is %s', async (_name, classify) => {
    const dir = await makeGraphDir(files(['issues', 'missing']));
    const harness = { name: 'custom', package: 'custom', classify: () => undefined };
    Object.defineProperty(harness, 'classify', { value: classify });
    await expect(readGraph(dir, [harness])).rejects.toThrow('agents/a.md: tools: unknown tool missing');
  });

  it('still reserves the union of all harness built-ins', async () => {
    const dir = await makeGraphDir({ ...files(['issues']), 'plugins/search.ts': pluginSource(['grep']) });
    await expect(
      readGraph(dir, [
        { name: 'custom', package: 'custom', classify: name => (name === 'read' ? 'read' : undefined) },
        { name: 'other', package: 'other', classify: name => (name === 'grep' ? 'read' : undefined) },
      ])
    ).rejects.toThrow('tool grep is a harness built-in');
  });
});
