import { getSha } from './hash.ts';
import { readOrUndefined } from './read.ts';
import { lstat, readdir, readFile, realpath } from 'node:fs/promises';
import type { IncomingMessage } from 'node:http';
import { extname, join, sep } from 'node:path';
import { registerHooks } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { tool as aiTool, asSchema, jsonSchema, type JSONSchema7, type Tool, type ToolExecutionOptions } from 'ai';
import {
  Effect,
  type Layer,
  type Option,
  type Redacted,
  Result,
  Schema,
  SchemaIssue,
  SchemaRepresentation,
} from 'effect';
import type { Issue, IssueStatus } from './event.ts';
import type { InstanceHosts } from './types.ts';

registerHooks({
  resolve(specifier, context, nextResolve) {
    const local = {
      '@jannik-stacks/agi/plugins': 'plugin',
      '@jannik-stacks/agi/trackers': 'trackers',
      '@jannik-stacks/agi/runners': 'runners',
    }[specifier];
    if (local)
      return { url: new URL(`./${local}${extname(import.meta.filename)}`, import.meta.url).href, shortCircuit: true };
    if (['effect', 'ai', 'jose'].some(name => specifier === name || specifier.startsWith(`${name}/`))) {
      if (context.conditions.includes('require')) return { url: import.meta.resolve(specifier), shortCircuit: true };
      return nextResolve(specifier, { ...context, parentURL: import.meta.url });
    }
    return nextResolve(specifier, context);
  },
});

export type ToolContext<S = undefined> = {
  readonly repo: string;
  readonly readFile: (ref: string) => Promise<{ bytes: Uint8Array; type: 'image/png' | 'image/jpeg' }>;
  readonly settings: S;
  readonly tracker: {
    readonly searchIssues: (
      query: string,
      options?: { state?: Exclude<Issue['state'], 'merged'> | 'all'; limit?: number }
    ) => Promise<Issue[]>;
  };
} & Pick<ToolExecutionOptions<unknown>, 'abortSignal'>;

export { issueStatuses } from './event.ts';
export type { InstanceHost, InstanceHosts } from './types.ts';
export { sumHumanInteractions } from './results.ts';

export type TrackerHost = {
  repo: string;
  fork?: string;
  studio: string;
  app: Option.Option<{ id: string; key: Redacted.Redacted }>;
  dir?: string;
};

type TrackerMember = (host: TrackerHost) => unknown;

export type RunnerHost = { data: string; image?: string; cache?: string; direct?: string[] };

type RunnerMember<S, L = Layer.Layer<never, unknown>> = (host: RunnerHost, settings: S) => L;

export type AuthRequest = Pick<IncomingMessage, 'headers'> & { url: URL; form?: URLSearchParams };

export type AuthResult =
  | { kind: 'user'; user: string }
  | { kind: 'login'; url: string }
  | { kind: 'refuse'; why: string };

export type AuthHost = { env: NodeJS.ProcessEnv };

type AuthMember<S> = (host: AuthHost, settings: S) => (request: AuthRequest) => AuthResult | Promise<AuthResult>;

export type StatusChange = { issue: number; repo: string; from?: IssueStatus; to: IssueStatus };

export type HookContext<S = undefined> = Omit<ToolContext<S>, 'readFile' | 'abortSignal'> & {
  readonly tracker: {
    readonly writeField?: (
      issue: number,
      field: { project: string; field: string; value: string | null }
    ) => Promise<void>;
  };
};

type StatusHook<S> = (change: StatusChange, context: HookContext<S>) => unknown;

type Node = Record<string, unknown>;
const map = (node: unknown, f: (node: Node) => unknown): unknown =>
  Array.isArray(node)
    ? node.map(n => map(n, f))
    : node && Object.getPrototypeOf(node) === Object.prototype
      ? f(Object.fromEntries(Object.entries(node).map(([k, v]) => [k, map(v, f)])))
      : node;

const { checks: finite } = SchemaRepresentation.toRepresentation(Schema.Finite.ast).representation as Extract<
  SchemaRepresentation.Representation,
  { _tag: 'Number' }
>;

const narrow = (node: Node) => {
  if (node._tag === 'Number') return { ...node, checks: [...(node.checks as Node[]), ...finite] };
  if (node._tag !== 'Union') return node;
  const types = (node.types as Node[]).filter(t => t._tag !== 'Undefined');
  return types.length === 1 && !(node.checks as unknown[]).length && !node.annotations ? types[0] : { ...node, types };
};

const advertise = (schema: Schema.Top) => {
  const representation = map(SchemaRepresentation.toRepresentation(schema.ast), narrow);
  const { schema: root, definitions } = SchemaRepresentation.toJsonSchemaDocument(
    representation as SchemaRepresentation.Document,
    { onExcessProperty: 'error' }
  );
  return Object.keys(definitions).length ? { ...root, $defs: definitions } : root;
};

export const tool = <A, I, S = undefined>(definition: {
  description: string;
  inputSchema: Schema.Codec<A, I>;
  execute: (input: A, context: ToolContext<S>) => unknown;
}): Tool<A, unknown, ToolContext<S>> => {
  const advertised = advertise(definition.inputSchema);
  return aiTool<A, unknown, ToolContext<S>>({
    description: definition.description,
    inputSchema: jsonSchema<A>(advertised as JSONSchema7, {
      validate: async value => {
        const decoded = await Effect.runPromise(
          Effect.result(Schema.decodeUnknownEffect(definition.inputSchema, { onExcessProperty: 'error' })(value))
        );
        return decoded._tag === 'Success'
          ? { success: true, value: decoded.success }
          : { success: false, error: new Error(String(decoded.failure)) };
      },
    }),
    execute: (input, { context, abortSignal }) =>
      definition.execute(input, { ...context, ...(abortSignal && { abortSignal }) }),
  });
};

const members = ['studio', 'tracker', 'runner', 'auth'] as const;

export const makePlugin = <
  S = undefined,
  D = unknown,
  I = D,
  T = unknown,
  H = InstanceHosts,
  L extends Layer.Layer<never, unknown> = Layer.Layer<never, unknown>,
>(
  definition: Omit<typeof PluginFile.Type, 'settingsSchema' | 'tools' | 'on' | (typeof members)[number]> & {
    tracker?: (host: TrackerHost) => T;
    runner?: RunnerMember<S, L>;
    auth?: AuthMember<S>;
    studio?: Omit<typeof StudioPage.Type, 'dataSchema' | 'read' | 'watch'> & {
      dataSchema: Schema.Codec<D, I>;
      read: (settings: S, hosts: H) => Effect.Effect<D, unknown>;
      watch?: (settings: S, hosts: H) => readonly string[];
    };
    tools?: Record<string, Tool<Parameters<NonNullable<Tool['execute']>>[0], unknown, ToolContext<S>>>;
    on?: { status?: StatusHook<S> };
  } & ([S] extends [undefined]
      ? { settingsSchema?: Schema.Codec<S, unknown> }
      : { settingsSchema: Schema.Codec<S, unknown> })
) => ({ ...definition, tools: definition.tools ?? {} });

const StudioPage = Schema.Struct({
  title: Schema.Trimmed.check(Schema.isNonEmpty()),
  page: Schema.URL.check(Schema.makeFilter(url => url.protocol === 'file:' && url.pathname.endsWith('.tsx'))),
  dataSchema: Schema.declare((value): value is Schema.Codec<unknown, unknown> => Schema.isSchema(value)),
  read: Schema.declare(
    (value): value is (settings: unknown, hosts: unknown) => Effect.Effect<unknown, unknown> =>
      typeof value === 'function'
  ),
  watch: Schema.optional(
    Schema.declare(
      (value): value is (settings: unknown, hosts: unknown) => readonly string[] => typeof value === 'function'
    )
  ),
});

const PluginFile = Schema.Struct({
  name: Schema.String.check(Schema.isPattern(/^[a-zA-Z][a-zA-Z0-9_-]*$/)),
  settingsSchema: Schema.optional(
    Schema.declare((value): value is Schema.Codec<unknown, unknown> => Schema.isSchema(value))
  ),
  studio: Schema.optional(StudioPage),
  tracker: Schema.optional(Schema.declare((value): value is TrackerMember => typeof value === 'function')),
  runner: Schema.optional(Schema.declare((value): value is RunnerMember<unknown> => typeof value === 'function')),
  auth: Schema.optional(Schema.declare((value): value is AuthMember<unknown> => typeof value === 'function')),
  on: Schema.optional(
    Schema.Struct({
      status: Schema.optional(Schema.declare((value): value is StatusHook<unknown> => typeof value === 'function')),
    })
  ),
  tools: Schema.Record(
    Schema.String,
    Schema.declare(
      (value): value is Tool =>
        typeof value === 'object' &&
        value !== null &&
        'execute' in value &&
        typeof value.execute === 'function' &&
        'inputSchema' in value &&
        'description' in value &&
        typeof value.description === 'string'
    )
  ).pipe(Schema.withDecodingDefaultType(Effect.succeed({}))),
});

export const readPlugins = async (
  dir: string | undefined,
  settings: Record<string, unknown> = {},
  {
    isReserved = () => false,
    builtins = [],
    instances = {},
  }: {
    isReserved?: (name: string) => boolean;
    builtins?: readonly unknown[];
    instances?: InstanceHosts;
  } = {}
) => {
  const plugins = new Map<string, string>();
  const tools: Record<string, { tool: Tool; settings: unknown; plugin: string }> = {};
  const hooks: { plugin: string; settings: unknown; status: StatusHook<unknown> }[] = [];
  const trackers: Record<string, NonNullable<typeof PluginFile.Type.tracker>> = {};
  const runners: Record<string, (host: RunnerHost) => Layer.Layer<never, unknown>> = {};
  const auths: Record<string, (host: AuthHost) => ReturnType<AuthMember<unknown>>> = {};
  const pages: (Pick<typeof StudioPage.Type, 'title' | 'page' | 'dataSchema'> & {
    name: string;
    builtin: boolean;
    read: () => ReturnType<(typeof StudioPage.Type)['read']>;
    watch: readonly string[];
  })[] = [];
  const builtin = 'the built-in plugins';
  const sources: { file: string; definition: unknown }[] = builtins.map(definition => ({ file: builtin, definition }));
  if (dir !== undefined) {
    const root = await realpath(dir);
    const files = ((await readdir(join(dir, 'plugins')).catch(readOrUndefined)) ?? [])
      .filter(file => file.endsWith('.ts'))
      .toSorted();
    for (const file of files) {
      const path = join(dir, 'plugins', file);
      const actual = await realpath(path);
      if (!actual.startsWith(root + sep)) throw new Error(`plugins/${file}: symlink escapes the graph`);
      if ((await lstat(path)).isSymbolicLink()) throw new Error(`plugins/${file}: symlink entries are not supported`);
      const hash = getSha(await readFile(actual));
      const source = await import(`${pathToFileURL(actual).href}?sha=${hash}`).catch(error => {
        throw new Error(`plugins/${file}: ${(error as Error).message}`, { cause: error });
      });
      sources.push({ file: `plugins/${file}`, definition: source.default });
    }
  }
  for (const { file, definition } of sources) {
    const decodedPlugin = Schema.decodeUnknownResult(PluginFile, { onExcessProperty: 'error' })(definition);
    if (Result.isFailure(decodedPlugin)) throw new Error(`${file}: ${decodedPlugin.failure.message}`);
    const plugin = decodedPlugin.success;
    const previous = plugins.get(plugin.name);
    if (previous) throw new Error(`${file}: plugin ${plugin.name} already defined in ${previous}`);
    const configured = Object.hasOwn(settings, plugin.name) ? settings[plugin.name] : undefined;
    if (!plugin.settingsSchema && configured !== undefined)
      throw new Error(`plugins.${plugin.name}: plugin has no settingsSchema`);
    let decoded: unknown;
    if (plugin.settingsSchema) {
      const result = Schema.decodeUnknownResult(plugin.settingsSchema, { onExcessProperty: 'error' })(
        configured === undefined ? {} : configured
      );
      if (Result.isFailure(result))
        throw new Error(
          SchemaIssue.makeFormatterStandardSchemaV1()(result.failure.issue)
            .issues.map(issue => `${['plugins', plugin.name, ...(issue.path ?? [])].join('.')}: ${issue.message}`)
            .join('\n')
        );
      decoded = result.success;
    }
    const names = Object.keys(plugin.tools);
    if (!names.length && !plugin.on?.status && !members.some(member => plugin[member]))
      throw new Error(`${file}: plugin has none of tools, hooks, ${members.join(', ')}`);
    if (plugin.tracker) trackers[plugin.name] = plugin.tracker;
    const { runner } = plugin;
    if (runner) runners[plugin.name] = host => runner(host, decoded);
    const { auth } = plugin;
    if (auth) auths[plugin.name] = host => auth(host, decoded);
    if (plugin.on?.status) hooks.push({ plugin: plugin.name, settings: decoded, status: plugin.on.status });
    if (plugin.studio) {
      const { title, dataSchema, page, read, watch } = plugin.studio;
      const actual = await realpath(fileURLToPath(page));
      if (extname(actual) !== '.tsx' || !(await lstat(actual)).isFile())
        throw new Error(`${file}: studio page needs a TSX file`);
      const roots = watch?.(decoded, instances) ?? [];
      if (!Array.isArray(roots) || !roots.every(root => typeof root === 'string'))
        throw new Error(`${file}: studio watch needs paths`);
      pages.push({
        name: plugin.name,
        builtin: file === builtin,
        title,
        dataSchema,
        page: pathToFileURL(actual),
        read: () => read(decoded, instances),
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
  return { tools, pages, hooks, trackers, runners, auths, names: [...plugins.keys()] };
};
