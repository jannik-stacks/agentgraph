import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import { describe, expect, expectTypeOf, it } from 'vitest';
import { Effect, Schema } from 'effect';
import { asSchema } from 'ai';
import { loadGraph } from '../src/folder.ts';
import { makePlugin, readPlugins, tool } from '../src/plugin.ts';

const source = (name = 'search', toolName = 'issues') => `
import { makePlugin, readPlugins, tool } from '${pathToFileURL(join(import.meta.dirname, '../src/plugin.ts')).href}';
import { Schema } from '${import.meta.resolve('effect')}';
const settings=Schema.Struct({limit:Schema.NumberFromString});
export default makePlugin<typeof settings.Type>({name:'${name}',settingsSchema:settings,tools:{'${toolName}':tool({description:'Search issues',inputSchema:Schema.Struct({query:Schema.String}),execute:({query},ctx)=>ctx.forge.searchIssues(query,{limit:ctx.settings.limit})})}});
`;

const makePluginDir = async (files: Record<string, string>) => {
  const dir = await mkdtemp(join(tmpdir(), 'agentgraph-plugins-'));
  await Promise.all(
    Object.entries(files).map(async ([path, text]) => {
      await mkdir(dirname(join(dir, path)), { recursive: true });
      await writeFile(join(dir, path), text);
    })
  );
  return dir;
};

const readCheckedPlugins = async (dir: string, settings: Record<string, unknown> = {}) => {
  await writeFile(join(dir, 'settings.yaml'), `repo: o/r\nplugins: ${JSON.stringify(settings)}\n`);
  const graph = await Effect.runPromise(loadGraph(dir, []));
  return readPlugins(graph.dir, graph.plugins);
};

const externalSource = `
import { Schema } from 'effect';
import { tool as sdkTool } from 'ai';
import { makePlugin, tool } from '@jannik-stacks/agi/plugins';
export { sdkTool };
export const Input = Schema.Struct({ query: Schema.String });
export const getScalar = async () => (await import('effect/Schema')).String;
export default makePlugin({ name: 'external', settingsSchema: Input, tools: {
  issues: tool({ description: 'Search', inputSchema: Input, execute: input => input }),
} });
`;

const readExternalPlugin = (dir: string) =>
  JSON.parse(
    execFileSync(
      process.execPath,
      [
        '--input-type=module',
        '--eval',
        `
import { Schema } from 'effect';
import { asSchema, tool as aiTool } from 'ai';
import { readPlugins } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/plugin.ts')).href)};
const registry = await readPlugins(${JSON.stringify(dir)}, { external: { query: 'cache' } });
const plugin = await import(${JSON.stringify(pathToFileURL(join(dir, 'plugins/external.ts')).href)});
console.log(JSON.stringify({
  isSharedEffect: plugin.Input.fields.query === Schema.String,
  isSharedAi: plugin.sdkTool === aiTool,
  isSharedLazy: await plugin.getScalar() === Schema.String,
  decoded: Schema.decodeUnknownSync(plugin.Input)({ query: 'retry' }),
  settings: registry.tools.issues.settings,
  validation: await asSchema(registry.tools.issues.tool.inputSchema).validate({ query: 'retry' }),
  local: plugin.local,
  cjs: plugin.cjsScalar && { isSharedEffect: plugin.cjsScalar === Schema.String, isSharedAi: plugin.cjsTool === aiTool },
}));
`,
      ],
      { cwd: join(import.meta.dirname, '..'), encoding: 'utf8' }
    )
  );

describe('graph plugins', () => {
  it('loads engine packages from an external graph without node_modules and shares Effect schemas', async () => {
    const dir = await makePluginDir({ 'plugins/external.ts': externalSource });
    await expect(access(join(dir, 'node_modules'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(readExternalPlugin(dir)).toEqual({
      isSharedEffect: true,
      isSharedAi: true,
      isSharedLazy: true,
      decoded: { query: 'retry' },
      settings: { query: 'cache' },
      validation: { success: true, value: { query: 'retry' } },
    });
  });

  it('keeps graph packages local while sharing engine packages, subpaths and CommonJS imports', async () => {
    const dir = await makePluginDir({
      'plugins/external.ts':
        externalSource.replace("import { Schema } from 'effect';", "import * as Schema from 'effect/Schema';") +
        "export { marker as local, cjsScalar, cjsTool } from 'graph-only';",
      'node_modules/graph-only/package.json': '{"main":"index.cjs"}',
      'node_modules/graph-only/index.cjs': `
exports.marker = 'graph package';
exports.cjsScalar = require('effect/Schema').String;
exports.cjsTool = require('ai').tool;
`,
      'node_modules/effect/package.json': '{"type":"module","exports":{".":"./index.js","./Schema":"./index.js"}}',
      'node_modules/effect/index.js': 'throw new Error("graph Effect must not load");',
      'node_modules/ai/package.json': '{"type":"module","exports":"./index.js"}',
      'node_modules/ai/index.js': 'throw new Error("graph AI SDK must not load");',
      'node_modules/@jannik-stacks/agi/package.json': '{"type":"module","exports":{"./plugins":"./index.js"}}',
      'node_modules/@jannik-stacks/agi/index.js': 'throw new Error("graph engine SDK must not load");',
    });
    expect(readExternalPlugin(dir)).toMatchObject({
      isSharedEffect: true,
      isSharedAi: true,
      isSharedLazy: true,
      decoded: { query: 'retry' },
      settings: { query: 'cache' },
      local: 'graph package',
      cjs: { isSharedEffect: true, isSharedAi: true },
    });
  });

  it('decodes only its settings and calls an SDK tool with typed input and context', async () => {
    const settings = Schema.Struct({ limit: Schema.NumberFromString });
    const plugin = makePlugin<typeof settings.Type>({
      name: 'search',
      settingsSchema: settings,
      tools: {
        issues: tool({
          description: 'Search issues',
          inputSchema: Schema.Struct({ query: Schema.String }),
          execute: async ({ query }, ctx) => {
            expectTypeOf(query).toEqualTypeOf<string>();
            expectTypeOf(ctx.settings.limit).toEqualTypeOf<number>();
            expectTypeOf(ctx.forge.searchIssues).parameter(0).toEqualTypeOf<string>();
            expectTypeOf(ctx.abortSignal).toEqualTypeOf<AbortSignal | undefined>();
            return { query, repo: ctx.repo, limit: ctx.settings.limit, isAborted: ctx.abortSignal?.aborted };
          },
        }),
      },
    });
    const dir = await makePluginDir({ 'plugins/search.ts': source() });
    const registry = await readCheckedPlugins(dir, { search: { limit: '10' } });
    const decoded = Schema.decodeUnknownSync(Schema.typeSchema(settings))(registry.tools.issues!.settings);
    const definition = plugin.tools.issues!;
    const schema = asSchema(definition.inputSchema);
    const parsed = await schema.validate!({ query: 'cache' });
    const result = await definition.execute!(
      { query: 'cache' },
      {
        toolCallId: 'search',
        messages: [],
        abortSignal: AbortSignal.abort(),
        context: { repo: 'o/r', settings: decoded, forge: { searchIssues: async () => [] } },
      }
    );
    const invalid = await schema.validate!({ query: 'cache', extra: true });
    expect(invalid.success).toBe(false);
    expect(parsed).toEqual({ success: true, value: { query: 'cache' } });
    expect(result).toEqual({ query: 'cache', repo: 'o/r', limit: 10, isAborted: true });
  });

  it('loads plugins in filename order and decodes separate namespaces', async () => {
    const dir = await makePluginDir({ 'plugins/a.ts': source(), 'plugins/lib/helper.ts': 'export const value = 1;' });
    const registry = await readCheckedPlugins(dir, { search: { limit: '10' } });
    expect(Object.keys(registry.tools)).toEqual(['issues']);
    expect(registry.tools.issues!.settings).toEqual({ limit: 10 });
    expect(registry.tools.issues!.plugin).toBe('search');
  });

  it.each([
    ['unknown namespace', { search: { limit: '10' }, ghost: {} }, 'unknown plugin'],
    ['unknown setting', { search: { limit: '10', extra: true } }, 'extra'],
    ['invalid setting', { search: { limit: 'no' } }, 'plugins.search.limit'],
  ])('rejects %s', async (_name, settings, error) => {
    const dir = await makePluginDir({ 'plugins/a.ts': source() });
    await expect(readCheckedPlugins(dir, settings)).rejects.toThrow(error);
  });

  it.each([
    ['plugin id', source('search', 'other'), 'plugin search already defined'],
    ['tool name', source('other'), 'tool issues already defined'],
  ])('rejects a colliding %s', async (_name, second, error) => {
    const dir = await makePluginDir({ 'plugins/a.ts': source(), 'plugins/b.ts': second });
    await expect(readCheckedPlugins(dir, { search: { limit: '10' }, other: { limit: '10' } })).rejects.toThrow(error);
  });

  it('checks plugin settings in the graph and hashes local helper source', async () => {
    const dir = await makePluginDir({
      'settings.yaml': 'plugins: { search: { limit: "10" } }\n',
      'plugins/a.ts': source(),
      'plugins/lib/helper.ts': 'export const value = 1;',
    });
    const graph = await Effect.runPromise(loadGraph(dir, []));
    await writeFile(join(dir, 'plugins/lib/helper.ts'), 'export const value = 2;');
    const changed = await Effect.runPromise(loadGraph(dir, []));
    expect(graph.plugins).toEqual({ search: { limit: '10' } });
    expect(JSON.stringify(graph)).not.toContain('inputSchema');
    expect(changed.sha).not.toBe(graph.sha);
  });

  it('accepts selected plugin tools without requiring a harness classification', async () => {
    const dir = await makePluginDir({
      'settings.yaml': 'plugins: { search: { limit: "10" } }\n',
      'plugins/search.ts': source(),
      'agents/reader.md': '---\nharness: custom\ntools: [read, issues]\n---\n',
      'workflows/search.md': '---\non: issues\nagent: reader\n---\n',
    });
    const graph = await Effect.runPromise(
      loadGraph(dir, [
        {
          name: 'custom',
          classify: name => (name === 'read' ? 'read' : undefined),
          check: agent => (agent.tools.includes('issues') ? ['plugin tool reached harness check'] : []),
        },
      ])
    );
    expect(graph.agents.reader!.tools).toEqual(['read', 'issues']);
  });

  it('reserves tools classified by any harness during graph checks', async () => {
    const dir = await makePluginDir({
      'settings.yaml': 'plugins: { search: { limit: "10" } }\n',
      'plugins/a.ts': source('search', 'read'),
    });
    await expect(
      Effect.runPromise(
        loadGraph(dir, [
          { name: 'custom', classify: () => undefined },
          { name: 'reader', classify: name => (name === 'read' ? 'read' : undefined) },
        ])
      )
    ).rejects.toThrow('tool read is a harness built-in');
  });

  it('rejects a graph-discovery symlink outside the graph', async () => {
    const outside = await makePluginDir({ 'outside.ts': source() });
    const dir = await makePluginDir({ 'plugins/a.ts': source() });
    await symlink(join(outside, 'outside.ts'), join(dir, 'plugins/b.ts'));
    await expect(readCheckedPlugins(dir, { search: { limit: '10' } })).rejects.toThrow('symlink escapes');
  });

  it('rejects a discovery symlink whose target would escape source hashing', async () => {
    const dir = await makePluginDir({ 'entry.ts': source() });
    await mkdir(join(dir, 'plugins'));
    await symlink(join(dir, 'entry.ts'), join(dir, 'plugins/a.ts'));
    await expect(readCheckedPlugins(dir, { search: { limit: '10' } })).rejects.toThrow('symlink entries');
  });

  it('rejects settings on a plugin without a schema', async () => {
    const dir = await makePluginDir({
      'plugins/a.ts': source()
        .replace('settingsSchema:settings,', '')
        .replace('makePlugin<typeof settings.Type>', 'makePlugin')
        .replace('limit:ctx.settings.limit', 'limit:10'),
    });
    await expect(readCheckedPlugins(dir, { search: {} })).rejects.toThrow('no settingsSchema');
  });
});
