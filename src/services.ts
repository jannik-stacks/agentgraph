import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { Config, Effect, Layer, type Redacted } from 'effect';
import { fileForge, type Forge } from './forge.ts';
import { docker } from './docker.ts';
import { appToken, githubForge } from './github.ts';
import { harnesses } from './harnesses.ts';
import { loadHub } from './hub.ts';
import type { Sandbox } from './sandbox.ts';
import type { Session } from './session.ts';
import { fileStore, Store } from './store.ts';

export type Services = Forge | Store | Session | Sandbox;

/** Everything the runner reads from the environment. */
export type Settings = {
  repo: string;
  hub: string;
  data: string;
  every: number;
  proxy: { url: string; keys: Redacted.Redacted };
  prices: string;
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
  forge: Config.string('BOTHUB_FORGE').pipe(
    Config.orElse(() => Config.all({ id: Config.string('BOTHUB_APP_ID'), key: Config.redacted('BOTHUB_APP_KEY') }))
  ),
});

const github = (app: { repo: string; id: string; key: Redacted.Redacted }, trust?: readonly string[]) => {
  const token = appToken(app);
  return {
    forge: githubForge(app, globalThis.fetch, token, trust),
    origin: { origin: `https://github.com/${app.repo}.git`, token: token('read') },
  };
};

/** The production services, on GitHub or on a forge folder. Tests build their own from the file and host layers. */
export const layers = (s: Settings): Layer.Layer<Services> =>
  Layer.unwrapEffect(
    Effect.map(
      // a hub that does not load trusts no one; every tick reports why it does not load
      Effect.catchAll(
        Effect.map(loadHub(s.hub), hub => hub.trust),
        () => Effect.succeed<string[]>([])
      ),
      trust => {
        const { forge, origin } =
          typeof s.forge === 'string'
            ? { forge: fileForge(s.forge, undefined, trust), origin: { origin: join(s.forge, 'origin.git') } }
            : github({ repo: s.repo, ...s.forge }, trust);
        return Layer.mergeAll(
          forge,
          fileStore(s.data),
          harnesses(s).pipe(Layer.provideMerge(docker({ data: s.data, ...origin })))
        );
      }
    )
  );
