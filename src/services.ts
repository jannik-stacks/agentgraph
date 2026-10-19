import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, Effect, Layer, type Redacted } from 'effect';
import { fileForge, type Forge } from './forge.ts';
import { docker } from './docker.ts';
import { appToken, githubForge } from './github.ts';
import { harnesses } from './harnesses.ts';
import { hubAt } from './hub.ts';
import type { Sandbox } from './sandbox.ts';
import type { Session } from './session.ts';
import { checkLogs, fileStore, Store } from './store.ts';

export type Services = Forge | Store | Session | Sandbox;

/** Everything the runner reads from the environment. */
export type Settings = {
  repo: string;
  hub: string;
  data: string;
  every: number;
  proxy: { url: string; keys: Redacted.Redacted };
  prices: string;
  checkLogs: (typeof checkLogs)[number];
  /** A forge folder with its git remote in `origin.git`, or the GitHub App that acts on `repo`. */
  forge: string | { id: string; key: Redacted.Redacted };
};

const prices = fileURLToPath(new URL('../infra/local/prices.json', import.meta.url));

export const settings: Config.Config<Settings> = Config.all({
  repo: Config.string('BOTHUB_REPO'),
  hub: Config.string('BOTHUB_HUB').pipe(Config.withDefault('.bothub')),
  data: Config.string('BOTHUB_DATA').pipe(Config.withDefault('.bothub-data')),
  every: Config.number('BOTHUB_EVERY').pipe(Config.withDefault(5)),
  proxy: Config.all({
    url: Config.string('BOTHUB_PROXY_URL').pipe(Config.withDefault('http://litellm:4000/v1')),
    keys: Config.redacted('BOTHUB_PROXY_KEYS'),
  }),
  prices: Config.string('BOTHUB_PRICES').pipe(Config.withDefault(prices)),
  checkLogs: Config.literal(...checkLogs)('BOTHUB_CHECK_LOGS').pipe(Config.withDefault('all' as const)),
  forge: Config.string('BOTHUB_FORGE').pipe(
    Config.orElse(() => Config.all({ id: Config.string('BOTHUB_APP_ID'), key: Config.redacted('BOTHUB_APP_KEY') }))
  ),
});

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
    forge: (trust?: readonly string[]) => githubForge(app, globalThis.fetch, token, trust),
    origin: { origin: `https://github.com/${app.repo}.git`, token: token('read') },
  };
};

/** The production services. The hub is read once for its trust list. Tests build their own from the file and host layers. */
export const layers = (s: Settings): Layer.Layer<Services> => {
  const { forge, origin } = where(s);
  const sandbox = docker({ data: s.data, ...origin });
  // a hub that does not load trusts no one; every tick reports why it does not load
  const trust = Effect.scoped(Effect.map(hubAt(s.hub), hub => hub.trust)).pipe(
    Effect.provide(sandbox),
    Effect.catchAll(() => Effect.succeed<string[]>([]))
  );
  return Layer.unwrapEffect(
    Effect.map(trust, trust =>
      Layer.mergeAll(forge(trust), fileStore(s.data, s.checkLogs), harnesses(s).pipe(Layer.provideMerge(sandbox)))
    )
  );
};
