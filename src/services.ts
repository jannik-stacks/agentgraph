import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { isAbsolute, join, resolve } from 'node:path';
import { Config, ConfigProvider, Effect, Layer, Option, Redacted, Schema, Struct } from 'effect';
import { folder, type TrackerSetup } from './tracker.ts';
import { dockerSandbox, findMissingModelHosts, sandboxImage } from './docker.ts';
import { github } from './github.ts';
import type { Services } from './engine.ts';
import {
  type HarnessSettings,
  harnessSession,
  makeEnvProvider,
  parseModelUrls,
  splitNames,
  readConfiguredGraph,
  readHarnessSettings,
} from './harnesses.ts';
import { GraphError, parseGraphSettings } from './folder.ts';
import { readPlugins, type TrackerHost } from './plugin.ts';
import { readOrUndefined } from './read.ts';
import { remoteSandbox } from './remote.ts';
import { priceTable } from './prices.ts';
import { Sandbox } from './sandbox.ts';
import { checkLogs, fileStore } from './store.ts';

/** Everything the runner reads from the environment. */
export type Settings = {
  repo: string;
  graph: string;
  data: string;
  every: number;
  compress: number;
  proxy: { url: string; keys: Redacted.Redacted; models: string };
  passed: Record<string, Redacted.Redacted>;
  prices: string;
  /** The name prefix of each repo's docker volume for toolchains and package caches; empty for none. */
  cache: string;
  /** The image commands start in when a graph names none. */
  image: string;
  sandbox: string;
  checkLogs: (typeof checkLogs)[number];
  /** The studio's URL that posted bodies link back to; empty for none. */
  studio: string;
  trust: string[];
  /** A tracker plugin's name, or the path of a tracker folder with its git remote in `origin.git`. */
  tracker: string;
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
  sandbox: Config.String('AGENTGRAPH_SANDBOX_URL').pipe(Config.withDefault('')),
};

const app = ['AGENTGRAPH_APP_ENV', 'AGENTGRAPH_APP_ID', 'AGENTGRAPH_APP_KEY', 'AGENTGRAPH_APP_KEY_FILE'];

const trackerName = Config.all(
  ['AGENTGRAPH_TRACKER', ...app].map(name => Config.String(name).pipe(Config.withDefault('')))
).pipe(Config.map(([tracker, ...apps]) => tracker || (apps.some(Boolean) ? 'github' : '')));

export const readHostSettings = async (flags: Partial<Record<'data' | 'tracker', string | undefined>>) => {
  const s = await Effect.runPromise(
    Config.all({
      ...hostSettings,
      config: Config.option(Config.String('AGENTGRAPH_CONFIG')),
      tracker: trackerName,
    }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, makeEnvProvider()))
  );
  const tracker = flags.tracker || s.tracker || undefined;
  const data = resolve(flags.data ?? s.data);
  const file = join(data, 'config.ts');
  const config = Option.getOrElse(s.config, () => (!tracker && existsSync(file) ? file : undefined));
  return { ...s, data, tracker, config };
};

export const settings = Config.all({
  ...hostSettings,
  repo: Config.String('AGENTGRAPH_REPO'),
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
  trust: Config.String('AGENTGRAPH_TRUST').pipe(
    Config.map(trust => trust.split(',').map(login => login.trim())),
    Config.withDefault<string[]>([])
  ),
  app: Config.option(
    Config.all({ id: Config.String('AGENTGRAPH_APP_ID'), key: Config.Redacted('AGENTGRAPH_APP_KEY') })
  ),
  tracker: trackerName,
}).pipe(Effect.flatMap(s => Effect.map(passed, (p): Settings => ({ ...s, passed: p }))));

/**
 * The tracker plugin `name` names, from the built-ins and the plugins of `graph`, else a tracker folder at that path.
 * A graph read from the repo cannot bring its own tracker. Reads only; nothing is set up.
 */
export const pickTracker = async (
  name: string,
  graph?: { dir: string; fromRepo: boolean }
): Promise<{ tracker: (host: TrackerHost) => TrackerSetup; dir?: string } | { problem: string }> => {
  if (!name) return { problem: 'name a tracker with AGENTGRAPH_TRACKER or set the App env' };
  const text = graph && (await readFile(join(graph.dir, 'settings.yaml'), 'utf8').catch(readOrUndefined));
  const builtins = [github, folder];
  const { trackers, names } = await readPlugins(
    graph?.dir,
    parseGraphSettings(text, () => {})?.plugins,
    undefined,
    builtins
  );
  const named = Object.hasOwn(trackers, name);
  const dir = named ? undefined : resolve(name);
  if (named && graph?.fromRepo && !builtins.some(b => b.name === name))
    return {
      problem: `tracker ${name} is a plugin of a graph read from the repo; a runner loads it only from a graph on the host, with --dir`,
    };
  if (!named && names.includes(name)) return { problem: `plugin ${name} has no tracker` };
  if (dir !== undefined && !existsSync(dir))
    return { problem: `no tracker plugin ${name} and no folder ${dir}; trackers: ${Object.keys(trackers).join(', ')}` };
  return { tracker: trackers[named ? name : 'folder'] as (host: TrackerHost) => TrackerSetup, ...(dir && { dir }) };
};

const where = async (s: Settings) => {
  const graph = isAbsolute(s.graph) && existsSync(s.graph) ? { dir: s.graph, fromRepo: false } : undefined;
  const picked = await pickTracker(s.tracker, graph);
  if ('problem' in picked) throw new Error(picked.problem);
  return picked.tracker({ ...Struct.pick(s, ['repo', 'studio', 'app']), ...(picked.dir && { dir: picked.dir }) });
};

/**
 * The graph at `path`: a folder on the host when the path is absolute, else that folder in the repo at the head of its
 * default branch, so only a merged pull request changes it.
 */
export const graphAt = (path: string) =>
  isAbsolute(path)
    ? readConfiguredGraph(path)
    : Effect.flatMap(Sandbox, s => s.checkout('origin/HEAD')).pipe(
        Effect.mapError(e => new GraphError({ problems: [{ path, message: e.detail }] })),
        Effect.flatMap(work => readConfiguredGraph(join(work.dir, path)))
      );

const findLocalModelHosts = (url: string) =>
  Object.values(parseModelUrls(url))
    .flatMap(at => (URL.canParse(at) ? [new URL(at).hostname] : []))
    .filter(host => !host.includes('.') || host.endsWith('.internal'));

export const whyModelHostsMissing = Effect.gen(function* () {
  const missing = yield* findMissingModelHosts(
    findLocalModelHosts(yield* proxyUrl).filter(host => !host.includes('.'))
  );
  if (missing.length === 0) return undefined;
  return [
    `Nothing answers to ${missing.join(' or ')} on the sandbox network, so sessions cannot reach a model.`,
    'Start the model stack with `npm run up` in the agentgraph checkout (infra/local/README.md), or pick another provider.',
  ].join('\n');
});

/** The production services. The graph is read once for its trust list. Tests build their own from the file and host layers. */
export const makeProductionLayers = () => {
  let previous: string | undefined;
  let place: ReturnType<typeof where>;
  return (s: Settings): Layer.Layer<Services> => {
    const key = JSON.stringify([
      s.repo,
      s.studio,
      s.graph,
      s.tracker,
      Option.getOrUndefined(Option.map(s.app, app => [app.id, Redacted.value(app.key)])),
    ]);
    if (key !== previous) {
      place = where(s);
      previous = key;
    }
    const current = place;
    return Layer.unwrap(
      Effect.gen(function* () {
        const { layer: tracker, origin } = yield* Effect.promise(() => current);
        const sandbox = s.sandbox
          ? remoteSandbox({ url: s.sandbox, data: s.data, ...origin })
          : dockerSandbox({
              data: s.data,
              cache: s.cache,
              image: s.image,
              direct: findLocalModelHosts(s.proxy.url),
              ...origin,
            });
        // a graph that does not load trusts no one; every tick reports why it does not load
        const trust = s.trust.length
          ? s.trust
          : yield* Effect.scoped(Effect.map(graphAt(s.graph), graph => graph.trust)).pipe(
              Effect.provide(sandbox),
              Effect.catch(() => Effect.succeed<string[]>([]))
            );
        const config = yield* readHarnessSettings.pipe(
          Effect.catch(e =>
            Effect.as(Effect.logError('harness settings failed; sessions cannot start', e), {
              harnesses: [],
            } as HarnessSettings)
          )
        );
        return Layer.mergeAll(
          tracker(trust),
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
