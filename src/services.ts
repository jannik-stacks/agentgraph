import { homedir } from 'node:os';
import { existsSync } from 'node:fs';
import { isAbsolute, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, Effect, Layer, Redacted } from 'effect';
import { fileForge } from './forge.ts';
import { dockerSandbox, sandboxImage } from './docker.ts';
import { appToken, githubForge } from './github.ts';
import type { Services } from './engine.ts';
import { harnessSession, parseModelUrls, splitNames, readConfiguredHub, readHarnessSettings } from './harnesses.ts';
import { HubError } from './hub.ts';
import { remoteSandbox } from './remote.ts';
import { Sandbox } from './sandbox.ts';
import { checkLogs, fileStore } from './store.ts';

/** Everything the runner reads from the environment. */
export type Settings = {
  repo: string;
  hub: string;
  data: string;
  every: number;
  proxy: { url: string; keys: Redacted.Redacted; models: string };
  passed: Record<string, Redacted.Redacted>;
  prices: string;
  /** The docker volume toolchains and package caches live in; empty for none. */
  cache: string;
  /** The image commands start in when a hub names none. */
  image: string;
  sandbox: string;
  checkLogs: (typeof checkLogs)[number];
  /** The studio's URL that posted bodies link back to; empty for none. */
  studio: string;
  trust: string[];
  /** A forge folder with its git remote in `origin.git`, or the GitHub App that acts on `repo`. */
  forge: string | { id: string; key: Redacted.Redacted };
};

const prices = fileURLToPath(new URL('../infra/local/prices.json', import.meta.url));

const passed = Effect.flatMap(Config.string('AGENTGRAPH_SESSION_ENV').pipe(Config.withDefault('')), names =>
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
  image: Config.string('AGENTGRAPH_IMAGE').pipe(Config.withDefault(sandboxImage)),
};

const app = ['AGENTGRAPH_APP_ENV', 'AGENTGRAPH_APP_ID', 'AGENTGRAPH_APP_KEY', 'AGENTGRAPH_APP_KEY_FILE'];

export const readHostSettings = async (flags: Partial<Record<'data' | 'forge', string>>) => {
  const s = await Effect.runPromise(Config.all(hostSettings));
  const onForge = flags.forge !== undefined || app.some(name => process.env[name]);
  const data = resolve(flags.data ?? s.data);
  const config = join(data, 'config.ts');
  if (!onForge && !process.env.AGENTGRAPH_CONFIG && existsSync(config)) process.env.AGENTGRAPH_CONFIG = config;
  return { ...s, data, onForge };
};

export const settings = Config.all({
  ...hostSettings,
  repo: Config.string('AGENTGRAPH_REPO'),
  hub: Config.string('AGENTGRAPH_HUB').pipe(Config.withDefault('.agentgraph')),
  proxy: Config.all({
    url: Config.string('AGENTGRAPH_PROXY_URL').pipe(Config.withDefault('http://gateway:4000/v1')),
    keys: Config.redacted('AGENTGRAPH_PROXY_KEYS').pipe(Config.withDefault(Redacted.make(''))),
    models: Config.string('AGENTGRAPH_MODELS').pipe(Config.withDefault('')),
  }),
  prices: Config.string('AGENTGRAPH_PRICES').pipe(Config.withDefault(prices)),
  cache: Config.string('AGENTGRAPH_CACHE_VOLUME').pipe(Config.withDefault('agentgraph-cache')),
  sandbox: Config.string('AGENTGRAPH_SANDBOX_URL').pipe(Config.withDefault('')),
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
      origin: { origin: join(dir, 'origin.git') },
    };
  }
  const app = { repo: s.repo, ...s.forge };
  const token = appToken(app);
  return {
    forge: (trust?: readonly string[]) => githubForge(app, globalThis.fetch, token, trust, s.studio),
    origin: { origin: `https://github.com/${app.repo}.git`, token: token('read') },
  };
};

/**
 * The hub at `path`: a folder on the host when the path is absolute, else that folder in the repo at the head of its
 * default branch, so only a merged pull request changes it.
 */
export const hubAt = (path: string) =>
  isAbsolute(path)
    ? readConfiguredHub(path)
    : Effect.flatMap(Sandbox, s => s.checkout('origin/HEAD')).pipe(
        Effect.mapError(e => new HubError({ problems: [{ path, message: e.detail }] })),
        Effect.flatMap(work => readConfiguredHub(join(work.dir, path)))
      );

const hostsOf = (url: string) =>
  Object.values(parseModelUrls(url))
    .flatMap(at => (URL.canParse(at) ? [new URL(at).hostname] : []))
    .filter(host => !host.includes('.') || host.endsWith('.internal'));

/** The production services. The hub is read once for its trust list. Tests build their own from the file and host layers. */
export const makeProductionLayers = (s: Settings): Layer.Layer<Services> => {
  const { forge, origin } = where(s);
  const sandbox = s.sandbox
    ? remoteSandbox({ url: s.sandbox, data: s.data, ...origin })
    : dockerSandbox({ data: s.data, cache: s.cache, image: s.image, direct: hostsOf(s.proxy.url), ...origin });
  // a hub that does not load trusts no one; every tick reports why it does not load
  const trust = s.trust.length
    ? Effect.succeed(s.trust)
    : Effect.scoped(Effect.map(hubAt(s.hub), hub => hub.trust)).pipe(
        Effect.provide(sandbox),
        Effect.catchAll(() => Effect.succeed<string[]>([]))
      );
  const config = readHarnessSettings.pipe(Effect.orElseSucceed(() => ({ harnesses: [] })));
  return Layer.unwrapEffect(
    Effect.map(Effect.all([trust, config]), ([trust, config]) =>
      Layer.mergeAll(
        forge(trust),
        fileStore(s.data, s.checkLogs),
        harnessSession({ ...s, ...config }).pipe(Layer.provideMerge(sandbox))
      )
    )
  );
};
