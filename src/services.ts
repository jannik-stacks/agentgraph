import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { Config, Effect, Layer, Option, Redacted, Struct } from 'effect';
import { fileForge, type Forge } from './forge.ts';
import { dockerSandbox, findMissingModelHosts, sandboxImage } from './docker.ts';
import { appToken, githubForge } from './github.ts';
import type { Services } from './engine.ts';
import {
  type HarnessSettings,
  harnessSession,
  parseModelUrls,
  splitNames,
  readConfiguredGraph,
  readHarnessSettings,
} from './harnesses.ts';
import { GraphError } from './folder.ts';
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
  /** The docker volume toolchains and package caches live in; empty for none. */
  cache: string;
  /** The image commands start in when a graph names none. */
  image: string;
  sandbox: string;
  checkLogs: (typeof checkLogs)[number];
  /** The studio's URL that posted bodies link back to; empty for none. */
  studio: string;
  trust: string[];
  /** A forge folder with its git remote in `origin.git`, or the GitHub App that acts on `repo`. */
  forge: string | { id: string; key: Redacted.Redacted };
};

const proxyUrl = Config.string('AGENTGRAPH_PROXY_URL').pipe(Config.withDefault('http://gateway:4000/v1'));

const sessionEnv = new Set([
  'CLAUDE_CODE_OAUTH_TOKEN',
  'ANTHROPIC_API_KEY',
  'AGENTGRAPH_CHATGPT_AUTH',
  'OPENCODE_AUTH_CONTENT',
]);

const passed = Effect.flatMap(
  Config.string('AGENTGRAPH_SESSION_ENV').pipe(
    Config.withDefault(''),
    Config.validate({
      message: `AGENTGRAPH_SESSION_ENV may list only model login variables: ${[...sessionEnv].join(', ')}`,
      validation: names => splitNames(names).every(name => sessionEnv.has(name)),
    })
  ),
  names =>
    Effect.map(
      Effect.forEach(splitNames(names), name => Effect.map(Config.redacted(name), value => [name, value] as const)),
      Object.fromEntries<Redacted.Redacted>
    )
);

export const hostSettings = {
  data: Config.string('AGENTGRAPH_DATA').pipe(Config.withDefault(join(homedir(), '.agentgraph'))),
  every: Config.number('AGENTGRAPH_EVERY').pipe(
    Config.validate({ message: 'Expected minutes above 0', validation: n => n > 0 }),
    Config.withDefault(5)
  ),
  compress: Config.number('AGENTGRAPH_COMPRESS_DAYS').pipe(Config.withDefault(14)),
  image: Config.string('AGENTGRAPH_IMAGE').pipe(Config.withDefault(sandboxImage)),
  sandbox: Config.string('AGENTGRAPH_SANDBOX_URL').pipe(Config.withDefault('')),
};

const app = ['AGENTGRAPH_APP_ENV', 'AGENTGRAPH_APP_ID', 'AGENTGRAPH_APP_KEY', 'AGENTGRAPH_APP_KEY_FILE'];

export const readHostSettings = async (flags: Partial<Record<'data' | 'forge', string>>) => {
  const s = await Effect.runPromise(
    Config.all({ ...hostSettings, config: Config.option(Config.string('AGENTGRAPH_CONFIG')) })
  );
  const onForge = flags.forge !== undefined || app.some(name => process.env[name]);
  const data = resolve(flags.data ?? s.data);
  const file = join(data, 'config.ts');
  const config = Option.getOrElse(s.config, () => (!onForge && existsSync(file) ? file : undefined));
  return { ...s, data, onForge, config };
};

export const settings = Config.all({
  ...hostSettings,
  repo: Config.string('AGENTGRAPH_REPO'),
  graph: Config.string('AGENTGRAPH_DIR').pipe(Config.withDefault('.agentgraph')),
  proxy: Config.all({
    url: proxyUrl,
    keys: Config.redacted('AGENTGRAPH_PROXY_KEYS').pipe(Config.withDefault(Redacted.make(''))),
    models: Config.string('AGENTGRAPH_MODELS').pipe(Config.withDefault('')),
  }),
  prices: Config.string('AGENTGRAPH_PRICES').pipe(Config.withDefault(priceTable)),
  cache: Config.string('AGENTGRAPH_CACHE_VOLUME').pipe(Config.withDefault('agentgraph-cache')),
  checkLogs: Config.literal(...checkLogs)('AGENTGRAPH_CHECK_LOGS').pipe(Config.withDefault('all' as const)),
  studio: Config.string('AGENTGRAPH_STUDIO_URL').pipe(Config.withDefault('')),
  trust: Config.array(Config.string(), 'AGENTGRAPH_TRUST').pipe(Config.withDefault<string[]>([])),
  forge: Config.string('AGENTGRAPH_FORGE').pipe(
    Config.orElse(() =>
      Config.all({ id: Config.string('AGENTGRAPH_APP_ID'), key: Config.redacted('AGENTGRAPH_APP_KEY') })
    )
  ),
}).pipe(Effect.flatMap(s => Effect.map(passed, (p): Settings => ({ ...s, passed: p }))));

/** The forge for `trust` and the origin the sandbox mirrors, on GitHub or on a forge folder. */
const where = (s: Settings) => {
  if (typeof s.forge === 'string') {
    const dir = s.forge;
    return {
      forge: (trust?: readonly string[]) => fileForge(dir, undefined, trust),
      origin: { origin: join(dir, 'origin.git'), local: true },
    };
  }
  const app = { repo: s.repo, ...s.forge };
  const token = appToken(app);
  const forges = new Map<string, Layer.Layer<Forge>>();
  return {
    forge: (trust?: readonly string[]) => {
      const key = JSON.stringify(trust) ?? '';
      let layer = forges.get(key);
      if (!layer) {
        layer = githubForge(app, globalThis.fetch, token, trust, s.studio);
        forges.set(key, layer);
      }
      return layer;
    },
    origin: { origin: `https://github.com/${app.repo}.git`, token: token('read') },
  };
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
      typeof s.forge === 'string' ? s.forge : [s.forge.id, Redacted.value(s.forge.key)],
    ]);
    if (key !== previous) {
      place = where(s);
      previous = key;
    }
    const { forge, origin } = place;
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
      ? Effect.succeed(s.trust)
      : Effect.scoped(Effect.map(graphAt(s.graph), graph => graph.trust)).pipe(
          Effect.provide(sandbox),
          Effect.catchAll(() => Effect.succeed<string[]>([]))
        );
    const config = readHarnessSettings.pipe(
      Effect.catchAll(e =>
        Effect.as(Effect.logError('harness settings failed; sessions cannot start', e), {
          harnesses: [],
        } as HarnessSettings)
      )
    );
    return Layer.unwrapEffect(
      Effect.map(Effect.all([trust, config]), ([trust, config]) =>
        Layer.mergeAll(
          forge(trust),
          fileStore(s.data, s.checkLogs),
          harnessSession({
            ...Struct.pick(s, 'data', 'proxy', 'passed', 'prices'),
            ...Struct.pick(config, 'harnesses', 'providers', 'provider'),
          }).pipe(Layer.provideMerge(sandbox))
        )
      )
    );
  };
};
