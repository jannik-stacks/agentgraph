import { createHash } from 'node:crypto';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import { extname, join, sep } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tool as aiTool, asSchema, jsonSchema, type Tool, type ToolExecutionOptions } from 'ai';
import { Effect, Either, JSONSchema, ParseResult, Schema } from 'effect';
import type { Issue } from './event.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    if (specifier === '@jannik-stacks/agi/plugins')
      return { url: new URL(`./plugin${extname(import.meta.filename)}`, import.meta.url).href, shortCircuit: true };
    if (['effect', 'ai'].some(name => specifier === name || specifier.startsWith(`${name}/`))) {
      if (context.conditions.includes('require')) return { url: import.meta.resolve(specifier), shortCircuit: true };
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
});

export type ToolContext<S = undefined> = {
  readonly repo: string;
  /** The session's checkout on the host; read it, never write. */
  readonly dir: string;
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

export const makePlugin = <S = undefined, D = unknown, I = D>(
  definition: Omit<typeof PluginFile.Type, 'settingsSchema' | 'tools' | 'studio'> & {
    studio?: Omit<typeof StudioPage.Type, 'dataSchema' | 'read' | 'watch'> & {
      dataSchema: Schema.Schema<D, I>;
      read: (settings: S) => Effect.Effect<D, unknown>;
      watch?: (settings: S) => readonly string[];
    };
    tools?: Record<string, Tool<Parameters<NonNullable<Tool['execute']>>[0], unknown, ToolContext<S>>>;
  } & ([S] extends [undefined]
      ? { settingsSchema?: Schema.Schema<S, Schema.Schema.Any['Encoded']> }
      : { settingsSchema: Schema.Schema<S, Schema.Schema.Any['Encoded']> })
) => ({ ...definition, tools: definition.tools ?? {} });

const StudioPage = Schema.Struct({
  title: Schema.NonEmptyTrimmedString,
  page: Schema.URLFromSelf.pipe(Schema.filter(url => url.protocol === 'file:' && url.pathname.endsWith('.tsx'))),
  dataSchema: Schema.declare((value): value is Schema.Schema.AnyNoContext => Schema.isSchema(value)),
  read: Schema.declare(
    (value): value is (settings: unknown) => Effect.Effect<unknown, unknown> => typeof value === 'function'
  ),
  watch: Schema.optional(
    Schema.declare((value): value is (settings: unknown) => readonly string[] => typeof value === 'function')
  ),
});

const PluginFile = Schema.Struct({
  name: Schema.String.pipe(Schema.pattern(/^[a-zA-Z][a-zA-Z0-9_]*$/)),
  settingsSchema: Schema.optional(
    Schema.declare((value): value is Schema.Schema.AnyNoContext => Schema.isSchema(value))
  ),
  studio: Schema.optional(StudioPage),
  tools: Schema.optionalWith(
    Schema.Record({
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
    { default: () => ({}) }
  ),
});

export const readPlugins = async (
  dir: string | undefined,
  settings: Record<string, unknown> = {},
  isReserved: (name: string) => boolean = () => false,
  builtins: readonly unknown[] = []
) => {
  const plugins = new Map<string, string>();
  const tools: Record<string, { tool: Tool; settings: unknown; plugin: string }> = {};
  const pages: (Pick<typeof StudioPage.Type, 'title' | 'page' | 'dataSchema'> & {
    name: string;
    read: () => ReturnType<(typeof StudioPage.Type)['read']>;
    watch: readonly string[];
  })[] = [];
  const sources: { file: string; definition: unknown }[] = builtins.map((definition, index) => ({
    file: `built-in ${index}`,
    definition,
  }));
  if (dir !== undefined) {
    const root = await realpath(dir);
    const files = (
      await readdir(join(dir, 'plugins')).catch((e: NodeJS.ErrnoException) =>
        e.code === 'ENOENT' ? [] : Promise.reject(e)
      )
    )
      .filter(file => file.endsWith('.ts'))
      .toSorted();
    for (const file of files) {
      const path = join(dir, 'plugins', file);
      const actual = await realpath(path);
      if (!actual.startsWith(root + sep)) throw new Error(`plugins/${file}: symlink escapes the graph`);
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`plugins/${file}: symlink entries are not supported`);
      const hash = createHash('sha256')
        .update(await readFile(actual))
        .digest('hex');
      const source = await import(`${pathToFileURL(actual).href}?sha=${hash}`).catch(error => {
        throw new Error(`plugins/${file}: ${(error as Error).message}`, { cause: error });
      });
      sources.push({ file: `plugins/${file}`, definition: source.default });
    }
  }
  for (const { file, definition } of sources) {
    const decodedPlugin = Schema.decodeUnknownEither(PluginFile, { onExcessProperty: 'error' })(definition);
    if (Either.isLeft(decodedPlugin)) throw new Error(`${file}: ${decodedPlugin.left.message}`);
    const plugin = decodedPlugin.right;
    const previous = plugins.get(plugin.name);
    if (previous) throw new Error(`${file}: plugin ${plugin.name} already defined in ${previous}`);
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
    if (!names.length && !plugin.studio) throw new Error(`${file}: plugin has no tools or studio`);
    if (plugin.studio) {
      const { title, dataSchema, page, read, watch } = plugin.studio;
      const actual = await realpath(fileURLToPath(page));
      if (extname(actual) !== '.tsx' || !(await lstat(actual)).isFile())
        throw new Error(`${file}: studio page needs a TSX file`);
      const roots = watch?.(decoded) ?? [];
      if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string'))
        throw new Error(`${file}: studio watch needs paths`);
      pages.push({
        name: plugin.name,
        title,
        dataSchema,
        page: pathToFileURL(actual),
        read: () => read(decoded),
        watch: roots,
      });
    }
    plugins.set(plugin.name, `${file}`);
    for (const name of names) {
      if (!/^[a-zA-Z][a-zA-Z0-9_]*$/.test(name)) throw new Error(`${file}: invalid tool name ${name}`);
      if (isReserved(name)) throw new Error(`${file}: tool ${name} is a harness built-in`);
      const previous = tools[name];
      if (previous && Object.hasOwn(tools, name))
        throw new Error(`${file}: tool ${name} already defined in ${plugins.get(previous.plugin)}`);
      const definition = plugin.tools[name]!;
      const schema = asSchema(definition.inputSchema);
      if ((await schema.jsonSchema).type !== 'object' || !schema.validate)
        throw new Error(`${file}: tool ${name} needs an object inputSchema with validation`);
      tools[name] = { tool: definition, settings: decoded, plugin: plugin.name };
    }
  }
  for (const name of Object.keys(settings)) {
    if (!plugins.has(name)) throw new Error(`plugins.${name}: unknown plugin`);
  }
  return { tools, pages };
};
