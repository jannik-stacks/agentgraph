import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { ConfigProvider, Effect, Layer } from 'effect';
import { settle, sweep, tick } from './engine.ts';
import { hubAt, loadHub, type Hub } from './hub.ts';
import { layers, settings, type Services, type Settings } from './services.ts';
import type { Run } from './workflow.ts';

/** `KEY=value` lines of an env file, with the key file it names read in as `BOTHUB_APP_KEY`. */
export const appEnv = async (file: string | undefined): Promise<Record<string, string>> => {
  if (!file) return {};
  const vars = Object.fromEntries(
    (await readFile(file, 'utf8')).split('\n').flatMap(line => {
      const m = /^\s*(?:export\s+)?([A-Z_][A-Z0-9_]*)\s*=\s*(.*?)\s*$/.exec(line);
      return m ? [[m[1]!, m[2]!.replace(/^(['"])(.*)\1$/, '$2')]] : [];
    })
  );
  const keyFile = vars.BOTHUB_APP_KEY_FILE?.replace(/^~(?=\/|$)/, homedir());
  return { ...vars, ...(keyFile && { BOTHUB_APP_KEY: await readFile(keyFile, 'utf8') }) };
};

const configured = (extra: Record<string, string>) =>
  Effect.map(
    Effect.promise(() => appEnv(process.env.BOTHUB_APP_ENV)),
    app =>
      ConfigProvider.fromMap(new Map(Object.entries({ ...app, ...extra }))).pipe(
        ConfigProvider.orElse(() => ConfigProvider.fromEnv())
      )
  );

/**
 * Reads the settings, the App env file named by `BOTHUB_APP_ENV` and the environment, builds the services, catches up
 * with one sweep and then ticks every `every` minutes. With `one`, it looks at that issue once, or at every open issue once when `issue` is
 * `'all'`, and resolves with the runs it touched. The only place that leaves Effect.
 */
export const start = (
  one?: { hub: string; issue: number | 'all'; data: string },
  services: (s: Settings) => Layer.Layer<Services> = layers
): Promise<Run[]> => {
  const provided = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.provide(effect, Layer.unwrapEffect(Effect.map(settings, services)));
  const program = one
    ? Effect.gen(function* () {
        const hub = yield* loadHub(one.hub);
        const provider = yield* configured({ BOTHUB_REPO: hub.repo, BOTHUB_HUB: one.hub, BOTHUB_DATA: one.data });
        return yield* provided(one.issue === 'all' ? sweep(hub) : tick(hub, one.issue)).pipe(
          Effect.withConfigProvider(provider)
        );
      })
    : Effect.gen(function* () {
        const provider = yield* configured({});
        const loop = Effect.gen(function* () {
          const s = yield* settings;
          const look = (pass: (hub: Hub) => Effect.Effect<Run[], unknown, Services>) =>
            hubAt(s.hub).pipe(
              Effect.flatMap(pass),
              Effect.scoped,
              Effect.catchAll(e => Effect.logError(e))
            );
          yield* look(hub => sweep(hub, settle));
          return yield* Effect.forever(
            Effect.zipRight(
              Effect.sleep(`${s.every} minutes`),
              look(hub => tick(hub, undefined, false, settle))
            )
          );
        });
        yield* provided(loop).pipe(Effect.withConfigProvider(provider));
        return [];
      });
  return Effect.runPromise(program);
};
