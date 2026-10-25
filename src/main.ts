import { realpathSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { basename, dirname, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigProvider, Effect, Layer } from 'effect';
import {
  instruct,
  issueDebounceMs,
  scanIssuesAndRunningRuns,
  tick,
  type Instruction,
  type Services,
} from './engine.ts';
import { loadHub, type Hub } from './hub.ts';
import type { Config } from './harnesses.ts';
import { hubAt, makeProductionLayers, readConfig, settings, type Settings } from './services.ts';
import type { Run } from './workflow.ts';

/** The variables of an env file, with the key file it names read in as `AGENTGRAPH_APP_KEY`. */
export const readAppEnvWithKey = async (file: string | undefined): Promise<Record<string, string>> => {
  if (!file) return {};
  const vars = parseEnv(await readFile(file, 'utf8')) as Record<string, string>;
  const keyFile = vars.AGENTGRAPH_APP_KEY_FILE?.replace(/^~(?=\/|$)/, homedir());
  return { ...vars, ...(keyFile && { AGENTGRAPH_APP_KEY: await readFile(keyFile, 'utf8') }) };
};

/** The real path of `path`, through its nearest existing parent when it does not exist yet. */
const real = (path: string): string => {
  try {
    return realpathSync(path);
  } catch {
    const parent = dirname(resolve(path));
    return parent === resolve(path) ? parent : join(real(parent), basename(path));
  }
};

/** The data dir and its mirror, where they sit under a temp dir the OS may empty. */
export const temporary = (data: string): string[] => {
  const temps = [...new Set(['/tmp', tmpdir()].flatMap(d => [resolve(d), real(d)]))];
  return [data, join(data, 'mirror.git')].filter(p =>
    [resolve(p), real(p)].some(at => temps.some(t => at === t || at.startsWith(t + sep)))
  );
};

const warnTemporary = (data: string) =>
  Effect.forEach(temporary(data), p =>
    Effect.logWarning(`${p} is under a temp dir, which the OS may empty (macOS deletes files untouched for 3 days)`)
  );

const configured = (extra: Record<string, string>) =>
  Effect.map(
    Effect.promise(() => readAppEnvWithKey(process.env.AGENTGRAPH_APP_ENV)),
    app =>
      ConfigProvider.fromMap(new Map(Object.entries({ ...app, ...extra }))).pipe(
        ConfigProvider.orElse(() => ConfigProvider.fromEnv())
      )
  );

/**
 * Reads the settings, the App env file named by `AGENTGRAPH_APP_ENV` and the environment, builds the services, catches up
 * with one sweep and then ticks every `every` minutes. With `one`, it looks at that issue once, or at every open issue once when `issue` is
 * `'all'`, and resolves with the runs it touched. The only place that leaves Effect.
 */
export const start = (
  one?: { hub: string; issue: number | 'all'; data: string; instruction?: Instruction },
  services: (s: Settings, config: Config) => Layer.Layer<Services> = makeProductionLayers
): Promise<Run[]> => {
  const provided = <A, E>(effect: Effect.Effect<A, E, Services>, config: Config) =>
    Effect.provide(effect, Layer.unwrapEffect(Effect.map(settings, s => services(s, config))));
  const program = one
    ? Effect.gen(function* () {
        const config = yield* Effect.promise(() => readConfig());
        const hub = yield* loadHub(one.hub);
        const provider = yield* configured({
          AGENTGRAPH_REPO: hub.repo,
          AGENTGRAPH_HUB: one.hub,
          AGENTGRAPH_DATA: one.data,
        });
        yield* warnTemporary(one.data);
        return yield* provided(
          one.instruction
            ? instruct(hub, one.instruction)
            : one.issue === 'all'
              ? scanIssuesAndRunningRuns(hub)
              : tick(hub, one.issue),
          config
        ).pipe(Effect.withConfigProvider(provider));
      })
    : Effect.gen(function* () {
        const config = yield* Effect.promise(() => readConfig());
        const provider = yield* configured({});
        const loop = Effect.gen(function* () {
          const s = yield* settings;
          yield* warnTemporary(s.data);
          const look = (pass: (hub: Hub) => Effect.Effect<Run[], unknown, Services>) =>
            hubAt(s.hub).pipe(
              Effect.flatMap(pass),
              Effect.scoped,
              Effect.catchAll(e => Effect.logError(e))
            );
          yield* look(hub => scanIssuesAndRunningRuns(hub, issueDebounceMs));
          return yield* Effect.forever(
            Effect.zipRight(
              Effect.sleep(`${s.every} minutes`),
              look(hub => scanIssuesAndRunningRuns(hub, issueDebounceMs))
            )
          );
        });
        yield* provided(loop, config).pipe(Effect.withConfigProvider(provider));
        return [];
      });
  return Effect.runPromise(program);
};
