import { createHash } from 'node:crypto';
import { readdir, readFile, realpath } from 'node:fs/promises';
import { join, sep } from 'node:path';
import { pathToFileURL } from 'node:url';
import { tool as aiTool, asSchema, jsonSchema, type Tool, type ToolExecutionOptions } from 'ai';
import { Effect, Either, JSONSchema, ParseResult, Schema } from 'effect';
import type { Issue } from './event.ts';

export type ToolContext<S = undefined> = {
  readonly repo: string;
  readonly settings: S;
  readonly forge: {
    readonly searchIssues: (
      query: string,
      options?: { state?: Exclude<Issue['state'], 'merged'> | 'all'; limit?: number }
    ) => Promise<Issue[]>;
  };
} & Pick<ToolExecutionOptions<unknown>, 'abortSignal'>;

export const tool = <A, I, S = undefined>(definition: {
  description: string;
  inputSchema: Schema.Schema<A, I>;
  execute: (input: A, context: ToolContext<S>) => unknown;
}): Tool<A, unknown, ToolContext<S>> =>
  aiTool<A, unknown, ToolContext<S>>({
    description: definition.description,
    inputSchema: jsonSchema<A>(JSONSchema.make(definition.inputSchema), {
      validate: async value => {
        const decoded = await Effect.runPromise(
          Effect.either(Schema.decodeUnknown(definition.inputSchema, { onExcessProperty: 'error' })(value))
        );
        return decoded._tag === 'Right'
          ? { success: true, value: decoded.right }
          : { success: false, error: new Error(String(decoded.left)) };
      },
    }),
    execute: (input, { context, abortSignal }) =>
      definition.execute(input, { ...context, ...(abortSignal && { abortSignal }) }),
  });

export const makePlugin = <S = undefined>(
  definition: Omit<typeof PluginFile.Type, 'settingsSchema' | 'tools'> & {
    tools: Record<string, Tool<Parameters<NonNullable<Tool['execute']>>[0], unknown, ToolContext<S>>>;
  } & ([S] extends [undefined]
      ? { settingsSchema?: Schema.Schema<S, Schema.Schema.Any['Encoded']> }
      : { settingsSchema: Schema.Schema<S, Schema.Schema.Any['Encoded']> })
): typeof definition => definition;

const PluginFile = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-zA-Z][a-zA-Z0-9_]*$/)),
  settingsSchema: Schema.optional(
    Schema.declare((value): value is Schema.Schema.AnyNoContext => Schema.isSchema(value))
  ),
  tools: Schema.Record({
    key: Schema.String,
    value: Schema.declare(
      (value): value is Tool =>
        typeof value === 'object' &&
        value !== null &&
        'execute' in value &&
        typeof value.execute === 'function' &&
        'inputSchema' in value &&
        'description' in value &&
        typeof value.description === 'string'
    ),
  }),
});

export const readPlugins = async (
  dir: string,
  settings: Record<string, unknown> = {},
  isReserved: (name: string) => boolean = () => false
) => {
  const plugins = new Map<string, string>();
  const tools: Record<string, { tool: Tool; settings: unknown; plugin: string }> = {};
  const root = await realpath(dir);
  const files = (await readdir(join(dir, 'plugins')).catch(() => [])).filter(file => file.endsWith('.ts')).toSorted();
  for (const file of files) {
    const path = join(dir, 'plugins', file);
    const actual = await realpath(path);
    if (!actual.startsWith(root + sep)) throw new Error(`plugins/${file}: symlink escapes the graph`);
    const hash = createHash('sha256')
      .update(await readFile(actual))
      .digest('hex');
    const source = await import(`${pathToFileURL(actual).href}?sha=${hash}`).catch(error => {
      throw new Error(`plugins/${file}: ${(error as Error).message}`, { cause: error });
    });
    const decodedPlugin = Schema.decodeUnknownEither(PluginFile, { onExcessProperty: 'error' })(source.default);
    if (Either.isLeft(decodedPlugin)) throw new Error(`plugins/${file}: ${decodedPlugin.left.message}`);
    const plugin = decodedPlugin.right;
    const previous = plugins.get(plugin.name);
    if (previous) throw new Error(`plugins/${file}: plugin ${plugin.name} already defined in ${previous}`);
    const configured = Object.hasOwn(settings, plugin.name) ? settings[plugin.name] : undefined;
    if (!plugin.settingsSchema && configured !== undefined)
      throw new Error(`plugins.${plugin.name}: plugin has no settingsSchema`);
    let decoded: unknown;
    if (plugin.settingsSchema) {
      const result = Schema.decodeUnknownEither(plugin.settingsSchema, { onExcessProperty: 'error' })(
        configured === undefined ? {} : configured
      );
      if (Either.isLeft(result))
        throw new Error(
          ParseResult.ArrayFormatter.formatErrorSync(result.left)
            .map(issue => `${['plugins', plugin.name, ...issue.path].join('.')}: ${issue.message}`)
            .join('\n')
        );
      decoded = result.right;
    }
    const names = Object.keys(plugin.tools);
    if (!names.length) throw new Error(`plugins/${file}: plugin has no tools`);
    plugins.set(plugin.name, `plugins/${file}`);
    for (const name of names) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new Error(`plugins/${file}: invalid tool name ${name}`);
      if (isReserved(name)) throw new Error(`plugins/${file}: tool ${name} is a harness built-in`);
      const previous = tools[name];
      if (previous && Object.hasOwn(tools, name))
        throw new Error(`plugins/${file}: tool ${name} already defined in ${plugins.get(previous.plugin)}`);
      const definition = plugin.tools[name]!;
      const schema = asSchema(definition.inputSchema);
      if ((await schema.jsonSchema).type !== 'object' || !schema.validate)
        throw new Error(`plugins/${file}: tool ${name} needs an object inputSchema with validation`);
      tools[name] = { tool: definition, settings: decoded, plugin: plugin.name };
    }
  }
  for (const name of Object.keys(settings)) {
    if (!plugins.has(name)) throw new Error(`plugins.${name}: unknown plugin`);
  }
  return { tools };
};
