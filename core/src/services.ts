import { Config, Layer, type Redacted } from 'effect';
import type { Forge } from './forge.ts';
import { docker } from './docker.ts';
import { appToken, githubForge } from './github.ts';
import { harnesses } from './harnesses.ts';
import type { Sandbox } from './sandbox.ts';
import type { Session } from './session.ts';
import { fileStore, Store } from './store.ts';

export type Services = Forge | Store | Session | Sandbox;

/** Everything the runner reads from the environment. */
export type Settings = {
  repo: string;
  hub: string;
  data: string;
  port: number;
  every: number;
  proxy: { url: string; keys: Redacted.Redacted };
  app: { id: string; key: Redacted.Redacted };
};

export const settings: Config.Config<Settings> = Config.all({
  repo: Config.string('BOTHUB_REPO'),
  hub: Config.string('BOTHUB_HUB').pipe(Config.withDefault('.bothub')),
  data: Config.string('BOTHUB_DATA').pipe(Config.withDefault('.bothub-data')),
  port: Config.port('BOTHUB_PORT').pipe(Config.withDefault(5191)),
  every: Config.number('BOTHUB_EVERY').pipe(Config.withDefault(5)),
  proxy: Config.all({
    url: Config.string('BOTHUB_PROXY_URL').pipe(Config.withDefault('http://litellm:4000/v1')),
    keys: Config.redacted('BOTHUB_PROXY_KEYS'),
  }),
  app: Config.all({ id: Config.string('BOTHUB_APP_ID'), key: Config.redacted('BOTHUB_APP_KEY') }),
});

/** The production services. Tests build their own from the file and host layers. */
export const layers = (s: Settings): Layer.Layer<Services> => {
  const app = { repo: s.repo, ...s.app };
  const token = appToken(app);
  return Layer.mergeAll(
    githubForge(app, globalThis.fetch, token),
    fileStore(s.data),
    harnesses(s).pipe(
      Layer.provideMerge(docker({ data: s.data, origin: `https://github.com/${s.repo}.git`, token }))
    )
  );
};
