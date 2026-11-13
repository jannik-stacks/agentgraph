import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Config, ConfigProvider, Context, Effect, Layer, Option, Redacted, Schema, Struct } from 'effect';
import { folder, type TrackerSetup } from './tracker.ts';
import { sandboxImage } from './docker.ts';
import { makeSandbox } from './mirror.ts';
import { github } from './github.ts';
import {
  type HarnessSettings,
  harnessSession,
  makeEnvProvider,
  parseModelUrls,
  splitNames,
  readOverrides,
  readHarnessSettings,
} from './harnesses.ts';
import { parseGraphSettings, type Graph } from './folder.ts';
import { readPlugins, type RunnerHost, type TrackerHost } from './plugin.ts';
import { readOrUndefined } from './read.ts';
import { none, password, token } from './auths.ts';
import { box, local } from './runners.ts';
import { Runner, SandboxError } from './sandbox.ts';
import { priceTable } from './prices.ts';
import { checkLogs, fileStore } from './store.ts';
import type { Services } from './run/execute.ts';

export type Settings = {
  repo: string;
  fork?: TrackerHost['fork'];
  graph: string;
  data: string;
  every: number;
  compress: number;
  proxy: { url: string; keys: Redacted.Redacted; models: string };
  passed: Record<string, Redacted.Redacted>;
  prices: string;
  cache: string;
  image: string;
  runner: string;
  checkLogs: (typeof checkLogs)[number];
  studio: string;
  trust: string[] | undefined;
  tracker: string;
  trackerDir: string;
  app: TrackerHost['app'];
};

const proxyUrl = Config.String('AGENTGRAPH_PROXY_URL').pipe(Config.withDefault('http://gateway:4000/v1'));

const sessionEnv = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'AGENTGRAPH_CHATGPT_AUTH',
  'OPENCODE_AUTH_CONTENT',
]);

const passed = Effect.flatMap(
  Config.schema(
    Schema.String.check(
      Schema.makeFilter(
        names =>
          splitNames(names).every(name => sessionEnv.has(name)) ||
          `AGENTGRAPH_SESSION_ENV may list only model login variables: ${[...sessionEnv].join(', ')}`
      )
    ),
    'AGENTGRAPH_SESSION_ENV'
  ).pipe(Config.withDefault('')),
  names =>
    Effect.map(
      Effect.forEach(splitNames(names), name => Effect.map(Config.Redacted(name), value => [name, value] as const)),
      Object.fromEntries<Redacted.Redacted>
    )
);

export const hostSettings = {
  data: Config.String('AGENTGRAPH_DATA').pipe(Config.withDefault(join(homedir(), '.agentgraph'))),
  every: Config.schema(
    Schema.NumberFromString.check(Schema.makeFilter(n => n > 0 || 'Expected minutes above 0')),
    'AGENTGRAPH_EVERY'
  ).pipe(Config.withDefault(5)),
  compress: Config.schema(
    Schema.NumberFromString.check(Schema.makeFilter(n => !Number.isNaN(n) || 'Expected a number')),
    'AGENTGRAPH_COMPRESS_DAYS'
  ).pipe(Config.withDefault(14)),
  image: Config.String('AGENTGRAPH_IMAGE').pipe(Config.withDefault(sandboxImage)),
  runner: Config.String('AGENTGRAPH_RUNNER').pipe(Config.withDefault('local')),
};

const app = ['AGENTGRAPH_APP_ENV', 'AGENTGRAPH_APP_ID', 'AGENTGRAPH_APP_KEY', 'AGENTGRAPH_APP_KEY_FILE'];

export const readTrackerName = Config.all(
  ['AGENTGRAPH_TRACKER', ...app].map(name => Config.String(name).pipe(Config.withDefault('')))
).pipe(Config.map(([tracker, ...apps]) => tracker || (apps.some(Boolean) ? 'github' : '')));

export const readHostSettings = async (flags: Partial<Record<'data' | 'tracker', string | undefined>>) => {
  const s = await Effect.runPromise(
    Config.all({
      ...hostSettings,
      config: Config.option(Config.String('AGENTGRAPH_CONFIG')),
      tracker: readTrackerName,
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, makeEnvProvider()))
  );
  const tracker = flags.tracker || s.tracker || undefined;
  const data = resolve(flags.data ?? s.data);
  const file = join(data, 'config.ts');
  const config = Option.getOrElse(s.config, () => (existsSync(file) ? file : undefined));
  return { ...s, data, tracker, config };
};

export const settings = Config.all({
  ...hostSettings,
  repo: Config.String('AGENTGRAPH_REPO'),
  fork: Config.option(
    Config.schema(Schema.String.check(Schema.isPattern(/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/)), 'AGENTGRAPH_FORK')
  ).pipe(Config.map(Option.getOrUndefined)),
  graph: Config.String('AGENTGRAPH_DIR').pipe(Config.withDefault('.agentgraph')),
  proxy: Config.all({
    url: proxyUrl,
    keys: Config.Redacted('AGENTGRAPH_PROXY_KEYS').pipe(Config.withDefault(Redacted.make(''))),
    models: Config.String('AGENTGRAPH_MODELS').pipe(Config.withDefault('')),
  }),
  prices: Config.String('AGENTGRAPH_PRICES').pipe(Config.withDefault(priceTable)),
  cache: Config.String('AGENTGRAPH_CACHE_VOLUME').pipe(Config.withDefault('agentgraph-cache')),
  checkLogs: Config.Literals(checkLogs, 'AGENTGRAPH_CHECK_LOGS').pipe(Config.withDefault('all' as const)),
  studio: Config.String('AGENTGRAPH_STUDIO_URL').pipe(Config.withDefault('')),
  trust: readOverrides.pipe(Config.map(overrides => overrides.trust)),
  app: Config.option(
    Config.all({ id: Config.String('AGENTGRAPH_APP_ID'), key: Config.Redacted('AGENTGRAPH_APP_KEY') })
  ),
  tracker: readTrackerName,
  trackerDir: Config.String('AGENTGRAPH_TRACKER_DIR').pipe(Config.withDefault('')),
}).pipe(Effect.flatMap(s => Effect.map(passed, (p): Settings => ({ ...s, passed: p }))));

const builtins = [github, folder, local, box, none, token, password];

type PluginGraph = { dir: string; fromRepo: boolean };

const readHostPlugins = async (graph?: PluginGraph) => {
  const text = graph && (await readFile(join(graph.dir, 'settings.yaml'), 'utf8').catch(readOrUndefined));
  const settings = parseGraphSettings(text, () => {});
  return { ...(await readPlugins(graph?.dir, settings?.plugins, { builtins })), settings };
};

const whereLoaded = {
  runner: 'the engine loads it only from a graph on the host, with --dir',
  auth: 'the studio loads it only from a graph on the host',
};

const whyUnpicked = (
  kind: keyof typeof whereLoaded,
  name: string,
  members: object,
  names: string[],
  graph?: PluginGraph
) => {
  if (!Object.hasOwn(members, name))
    return names.includes(name)
      ? `plugin ${name} has no ${kind}`
      : `no ${kind} plugin ${name}; ${kind}s: ${Object.keys(members).join(', ')}`;
  if (graph?.fromRepo && !builtins.some(b => b.name === name))
    return `${kind} ${name} is a plugin of a graph read from the repo; ${whereLoaded[kind]}`;
  return undefined;
};

const findHostGraph = (s: Pick<Settings, 'graph'>) =>
  isAbsolute(s.graph) && existsSync(s.graph) ? { dir: s.graph, fromRepo: false } : undefined;

const pickRunner = async (name: string, graph?: PluginGraph) => {
  const { runners, names } = await readHostPlugins(graph);
  const problem = whyUnpicked('runner', name, runners, names, graph);
  if (problem) return { problem };
  const plugin = runners[name]!;
  const fail = (detail: string) => new SandboxError({ reason: 'infra', detail });
  return {
    runner: (host: RunnerHost) =>
      Layer.effect(
        Runner,
        Layer.build(plugin(host)).pipe(
          Effect.mapError(e => (e instanceof SandboxError ? e : fail(`runner ${name}: ${String(e)}`))),
          Effect.flatMap(context =>
            Effect.fromOption(Context.getOption(context, Runner), () => fail(`runner ${name} provides no Runner`))
          )
        )
      ),
  };
};

export const pickAuth = async (chosen: string | undefined, graph?: PluginGraph) => {
  const { auths, names, settings } = await readHostPlugins(graph);
  if (graph?.fromRepo && settings?.auth !== undefined)
    return { problem: `auth in ${graph.dir}: a graph read from the repo cannot pick the studio's auth` };
  const name = chosen ?? settings?.auth ?? process.env.AGENTGRAPH_AUTH ?? 'token';
  const problem = whyUnpicked('auth', name, auths, names, graph);
  if (problem) return { problem };
  return { name, settings: settings?.plugins?.[name], auth: auths[name]! };
};

const makeRunnerHost = (s: Pick<Settings, 'data' | 'cache' | 'image' | 'proxy'>): RunnerHost => ({
  data: s.data,
  cache: s.cache,
  image: s.image,
  direct: findLocalModelHosts(s.proxy.url),
});

const buildRunner = (name: string, graph: Parameters<typeof pickRunner>[1], host: RunnerHost) =>
  Effect.gen(function* () {
    const picked = yield* Effect.promise(() => pickRunner(name, graph));
    if ('problem' in picked) return yield* Effect.fail(new Error(picked.problem));
    return Context.get(yield* Layer.build(picked.runner(host)), Runner);
  });

export const makeRunner = (s: Settings) => Effect.scoped(buildRunner(s.runner, findHostGraph(s), makeRunnerHost(s)));

export const whyRunnerRefuses = (
  s: Pick<Settings, 'runner' | 'data' | 'image'>,
  graph: Parameters<typeof pickRunner>[1],
  loaded: Graph
) =>
  s.runner === 'local'
    ? Effect.succeed(undefined)
    : Effect.scoped(buildRunner(s.runner, graph, { data: s.data, image: loaded.image ?? s.image })).pipe(
        Effect.map(runner => runner.whyRefused?.(loaded)),
        Effect.catch(e => Effect.succeed('detail' in e ? e.detail : e.message))
      );

export const pickTracker = async (
  name: string,
  graph?: PluginGraph
): Promise<{ tracker: (host: TrackerHost) => TrackerSetup; dir?: string } | { problem: string }> => {
  if (!name) return { problem: 'name a tracker with AGENTGRAPH_TRACKER or set the App env' };
  const { trackers, names } = await readHostPlugins(graph);
  const named = Object.hasOwn(trackers, name);
  const dir = named ? undefined : resolve(name);
  if (named && graph?.fromRepo && !builtins.some(b => b.name === name))
    return {
      problem: `tracker ${name} is a plugin of a graph read from the repo; the engine loads it only from a graph on the host, with --dir`,
    };
  if (!named && names.includes(name)) return { problem: `plugin ${name} has no tracker` };
  if (dir !== undefined && !existsSync(dir))
    return { problem: `no tracker plugin ${name} and no folder ${dir}; trackers: ${Object.keys(trackers).join(', ')}` };
  return { tracker: trackers[named ? name : 'folder'] as (host: TrackerHost) => TrackerSetup, ...(dir && { dir }) };
};

export const makeTrackerSetup = async (
  s: Pick<Settings, 'repo' | 'fork' | 'studio' | 'app' | 'graph' | 'tracker' | 'trackerDir'>
) => {
  const picked = await pickTracker(s.tracker, findHostGraph(s));
  if ('problem' in picked) throw new Error(picked.problem);
  const dir = picked.dir ?? s.trackerDir;
  const setup = picked.tracker({
    ...Struct.pick(s, ['repo', 'studio', 'app']),
    ...(s.fork && { fork: s.fork }),
    ...(dir && { dir }),
  });
  if (setup.origin.local && dir && setup.origin.origin !== join(dir, 'origin.git'))
    throw new Error(
      `tracker ${s.tracker} keeps its issues outside ${s.trackerDir}; an instance tracker wraps the folder it is given`
    );
  return setup;
};

const findLocalModelHosts = (url: string) =>
  Object.values(parseModelUrls(url))
    .flatMap(at => (URL.canParse(at) ? [new URL(at).hostname] : []))
    .filter(host => !host.includes('.') || host.endsWith('.internal'));

export const makeProductionLayers = (setup?: TrackerSetup) => {
  let previous: string | undefined;
  let place: ReturnType<typeof makeTrackerSetup>;
  let chosen: string | undefined;
  let picked: ReturnType<typeof pickRunner>;
  return (s: Settings): Layer.Layer<Services> => {
    const key = JSON.stringify([
      s.repo,
      s.fork,
      s.studio,
      s.graph,
      s.tracker,
      s.trackerDir,
      Option.getOrUndefined(Option.map(s.app, app => [app.id, Redacted.value(app.key)])),
    ]);
    if (key !== previous) {
      place = setup ? Promise.resolve(setup) : makeTrackerSetup(s);
      previous = key;
    }
    const current = place;
    if (chosen !== JSON.stringify([s.runner, s.graph])) {
      picked = pickRunner(s.runner, findHostGraph(s));
      chosen = JSON.stringify([s.runner, s.graph]);
    }
    const runner = picked;
    return Layer.unwrap(
      Effect.gen(function* () {
        const { layer: tracker, origin } = yield* Effect.promise(() => current);
        const found = yield* Effect.promise(() => runner);
        if ('problem' in found) return yield* Effect.die(new Error(found.problem));
        const sandbox = makeSandbox({ data: s.data, ...origin }).pipe(
          Layer.provide(Layer.orDie(found.runner(makeRunnerHost(s))))
        );
        const config = yield* readHarnessSettings.pipe(
          Effect.catch(e =>
            Effect.as(Effect.logError('harness settings failed; sessions cannot start', e), {
              harnesses: [],
            } as HarnessSettings)
          )
        );
        return Layer.mergeAll(
          tracker(s.trust),
          fileStore(s.data, s.checkLogs),
          harnessSession({
            ...Struct.pick(s, ['data', 'proxy', 'passed', 'prices']),
            ...Struct.pick(config, ['harnesses', 'providers', 'provider']),
          }).pipe(Layer.provideMerge(sandbox))
        );
      })
    );
  };
};
