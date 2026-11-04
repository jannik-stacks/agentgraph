import { execFileSync } from 'node:child_process';
import { access, mkdtemp, mkdir, writeFile, symlink, realpath } from 'node:fs/promises';
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
const settings=Schema.Struct({limit:Schema.FiniteFromString});
export default makePlugin<typeof settings.Type>({name:'${name}',settingsSchema:settings,tools:{'${toolName}':tool({description:'Search issues',inputSchema:Schema.Struct({query:Schema.String}),execute:({query},ctx)=>ctx.tracker.searchIssues(query,{limit:ctx.settings.limit})})}});
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
  await writeFile(join(dir, 'settings.yaml'), `plugins: ${JSON.stringify(settings)}\n`);
  const graph = await Effect.runPromise(loadGraph(dir, []));
  return readPlugins(graph.dir, graph.plugins);
};

it('loads settings under a hyphenated plugin name', async () => {
  const dir = await makePluginDir({ 'plugins/pr-img.ts': source('pr-img') });
  const loaded = await readCheckedPlugins(dir, { 'pr-img': { limit: '10' } });
  expect(loaded.tools.issues!.settings).toEqual({ limit: 10 });
});

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

it('lets a graph plugin wrap the built-in trackers by their package paths', async () => {
  const dir = await makePluginDir({
    'plugins/mine.ts': `import { folder } from '@jannik-stacks/agi/trackers';
export default { ...folder, name: 'mine' };
`,
  });
  const picked = execFileSync(
    process.execPath,
    [
      '--input-type=module',
      '--eval',
      `
import { readPlugins } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, '../src/plugin.ts')).href)};
const { trackers } = await readPlugins(${JSON.stringify(dir)}, {});
const { github } = await import('@jannik-stacks/agi/trackers');
console.log(trackers.mine({ dir: '/t' }).origin.origin, github.name);
`,
    ],
    { encoding: 'utf8', env: { ...process.env, NODE_OPTIONS: '' } }
  );
  expect(picked.trim()).toBe('/t/origin.git github');
});

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

describe('plugin directory errors', () => {
  it('rejects a plugin directory that is a file', async () => {
    const dir = await makePluginDir({ plugins: 'unreadable directory' });
    await expect(readPlugins(dir)).rejects.toThrow('ENOTDIR');
  });
});

describe('graph plugins', () => {
  it('loads a page-only plugin with decoded settings without reading its data', async () => {
    const dir = await makePluginDir({
      'plugins/count.ts': `
import { makePlugin } from '${pathToFileURL(join(import.meta.dirname, '../src/plugin.ts')).href}';
import { Effect, Schema } from '${import.meta.resolve('effect')}';
export default makePlugin({ name: 'count', settingsSchema: Schema.Struct({ limit: Schema.NumberFromString }),
studio: { title: 'Count', page: new URL('./pages/count.tsx', import.meta.url), dataSchema: Schema.NumberFromString,
read: settings => Effect.succeed(settings.limit), watch: settings => [String(settings.limit)] } });
`,
      'plugins/pages/count.tsx': 'throw new Error("Node must never import a page");',
    });
    const typed = makePlugin({
      name: 'typed',
      settingsSchema: Schema.Struct({ limit: Schema.NumberFromString }),
      studio: {
        title: 'Typed',
        page: pathToFileURL(join(dir, 'plugins/pages/count.tsx')),
        dataSchema: Schema.NumberFromString,
        read: settings => {
          expectTypeOf(settings.limit).toEqualTypeOf<number>();
          return Effect.succeed(settings.limit);
        },
      },
    });
    expect(await Effect.runPromise(typed.studio!.read({ limit: 2 }))).toBe(2);
    const registry = await readCheckedPlugins(dir, { count: { limit: '7' } });
    const page = registry.pages[0]!;
    const data = await Effect.runPromise(page.read());
    expect(registry.tools).toEqual({});
    expect(page).toMatchObject({ name: 'count', title: 'Count', watch: ['7'] });
    expect(page.page.pathname).toBe(await realpath(join(dir, 'plugins/pages/count.tsx')));
    expect(await Effect.runPromise(Schema.encodeEffect(page.dataSchema)(data))).toBe('7');
  });

  it('uses the same validation and collision rules for built-in pages', async () => {
    const dir = await makePluginDir({ 'Page.tsx': 'export default () => null;' });
    const page = makePlugin({
      name: 'results',
      studio: {
        title: 'Results',
        page: pathToFileURL(join(dir, 'Page.tsx')),
        dataSchema: Schema.String,
        read: settings => {
          expectTypeOf(settings).toEqualTypeOf<undefined>();
          return Effect.succeed('ok');
        },
      },
    });
    const loaded = await readPlugins(dir, {}, undefined, [page]);
    expect(await Effect.runPromise(loaded.pages[0]!.read())).toBe('ok');
    await expect(readPlugins(dir, {}, undefined, [page, page])).rejects.toThrow('plugin results already defined');
    await expect(
      readPlugins(dir, {}, undefined, [{ ...page, studio: { ...page.studio, extra: true } }])
    ).rejects.toThrow('extra');
  });

  it.each([
    ['empty', {}, 'no tools, studio, hooks or tracker'],
    [
      'remote',
      {
        studio: {
          title: 'Page',
          page: new URL('https://example.com/Page.tsx'),
          dataSchema: Schema.String,
          read: () => Effect.succeed('ok'),
        },
      },
      'filter',
    ],
    [
      'missing reader',
      { studio: { title: 'Page', page: pathToFileURL('/Page.tsx'), dataSchema: Schema.String } },
      'read',
    ],
  ])('rejects an invalid page: %s', async (_name, parts, error) => {
    const dir = await makePluginDir({});
    await expect(readPlugins(dir, {}, undefined, [{ name: 'page', ...parts }])).rejects.toThrow(error);
  });

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
            expectTypeOf(ctx.tracker.searchIssues).parameter(0).toEqualTypeOf<string>();
            expectTypeOf(ctx.abortSignal).toEqualTypeOf<AbortSignal | undefined>();
            return {
              query,
              repo: ctx.repo,
              limit: ctx.settings.limit,
              isAborted: ctx.abortSignal?.aborted,
            };
          },
        }),
      },
    });
    const dir = await makePluginDir({ 'plugins/search.ts': source() });
    const registry = await readCheckedPlugins(dir, { search: { limit: '10' } });
    const decoded = Schema.decodeUnknownSync(Schema.toType(settings))(registry.tools.issues!.settings);
    const definition = plugin.tools.issues!;
    const schema = asSchema(definition.inputSchema);
    const parsed = await schema.validate!({ query: 'cache' });
    const result = await definition.execute!(
      { query: 'cache' },
      {
        toolCallId: 'search',
        messages: [],
        abortSignal: AbortSignal.abort(),
        context: {
          readFile: async () => ({ bytes: new Uint8Array(), type: 'image/png' }),
          repo: 'o/r',
          settings: decoded,
          tracker: { searchIssues: async () => [] },
        },
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

describe('tool input schemas', () => {
  type Json = Record<string, unknown>;
  const matches = (schema: Json, value: unknown, root: Json = schema): boolean => {
    if (typeof schema.$ref === 'string')
      return matches(root.$defs![schema.$ref.slice('#/$defs/'.length) as never], value, root);
    if (Array.isArray(schema.anyOf)) return schema.anyOf.some(s => matches(s as Json, value, root));
    if (Array.isArray(schema.enum) && !schema.enum.includes(value)) return false;
    const kind = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (schema.type === 'integer') return Number.isInteger(value);
    if (schema.type && schema.type !== kind) return false;
    if (kind === 'array' && schema.items)
      return (value as unknown[]).every(v => matches(schema.items as Json, v, root));
    if (kind !== 'object') return true;
    const properties = (schema.properties ?? {}) as Record<string, Json>;
    const entries = Object.entries(value as Json);
    return (
      ((schema.required ?? []) as string[]).every(key => key in (value as Json)) &&
      entries.every(([key, v]) =>
        properties[key] ? matches(properties[key], v, root) : schema.additionalProperties !== false
      )
    );
  };
  interface Node {
    readonly size: number;
    readonly children?: readonly Node[];
  }
  const Node = Schema.Struct({
    size: Schema.Number,
    children: Schema.optionalKey(Schema.Array(Schema.suspend((): Schema.Codec<Node> => Node))),
  }).annotate({ identifier: 'Node' });
  const input = Schema.Struct({
    state: Schema.optional(Schema.Literals(['open', 'closed'])),
    note: Schema.NullOr(Schema.String),
    clear: Schema.optionalKey(Schema.NullOr(Schema.String)),
    count: Schema.Int,
    mode: Schema.optionalKey(Schema.Union([Schema.Number, Schema.Literals(['NaN', 'Infinity', '-Infinity'])])),
    tree: Node,
  });
  const valid = { note: null, count: 1, tree: { size: 1 } };

  it.each([
    ['the smallest input', valid],
    ['an optional literal', { ...valid, state: 'open' }],
    ['null for an optional field', { ...valid, state: null }],
    ['an unknown literal', { ...valid, state: 'all' }],
    ['a nullable field set', { ...valid, note: 'hi' }],
    ['a missing nullable field', { count: 1, tree: { size: 1 } }],
    ['null for an optional nullable field', { ...valid, clear: null }],
    ['a string for an optional nullable field', { ...valid, clear: 'x' }],
    ['NaN as a string', { ...valid, count: 'NaN' }],
    ['Infinity as a string', { ...valid, tree: { size: 'Infinity' } }],
    ['a declared Infinity string', { ...valid, mode: 'Infinity' }],
    ['a number beside declared strings', { ...valid, mode: 1.5 }],
    ['an undeclared string beside declared strings', { ...valid, mode: 'Inf' }],
    ['a fraction for an integer', { ...valid, count: 1.5 }],
    ['nested definitions', { ...valid, tree: { size: 1, children: [{ size: 2, children: [] }] } }],
    ['a bad nested node', { ...valid, tree: { size: 1, children: [{ size: 'big' }] } }],
    ['an extra key', { ...valid, extra: true }],
  ])('advertises what the validator accepts: %s', async (_name, value) => {
    const schema = asSchema(tool({ description: 'Probe', inputSchema: input, execute: x => x }).inputSchema);
    const advertised = (await schema.jsonSchema) as Json;
    expect(advertised.$defs).toHaveProperty('Node');
    expect(matches(advertised, value)).toBe((await schema.validate!(value)).success);
  });
});
