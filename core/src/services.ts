import { Config, Layer, type Redacted } from 'effect';
import { Forge } from './forge.ts';
import { githubForge } from './github.ts';
import { docker, Sandbox } from './sandbox.ts';
import { harnesses, Session } from './session.ts';
import { fileStore, Store } from './store.ts';

export type Services = Forge | Store | Session | Sandbox;

/** Everything the runner reads from the environment. */
export type Settings = {
  repo: string;
  hub: string;
  data: string;
  port: number;
  every: number;
  proxy: { url: string; key: Redacted.Redacted };
  app: { id: string; key: Redacted.Redacted };
};

export const settings: Config.Config<Settings> = Config.all({
  repo: Config.string('BOTHUB_REPO'),
  hub: Config.string('BOTHUB_HUB').pipe(Config.withDefault('.bothub')),
  data: Config.string('BOTHUB_DATA').pipe(Config.withDefault('.bothub-data')),
  port: Config.port('BOTHUB_PORT').pipe(Config.withDefault(5191)),
  every: Config.number('BOTHUB_EVERY').pipe(Config.withDefault(5)),
  proxy: Config.all({ url: Config.string('BOTHUB_PROXY_URL'), key: Config.redacted('BOTHUB_PROXY_KEY') }),
  app: Config.all({ id: Config.string('BOTHUB_APP_ID'), key: Config.redacted('BOTHUB_APP_KEY') }),
});

/** The production services. Tests build their own from the file and host layers. */
export const layers = (s: Settings): Layer.Layer<Services> =>
  Layer.mergeAll(
    githubForge({ repo: s.repo, ...s.app }),
    fileStore(s.data),
    harnesses.pipe(Layer.provideMerge(docker))
  );
