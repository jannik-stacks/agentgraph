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
import { writeIssueFile } from './forge.ts';
import { readConfiguredHub } from './harnesses.ts';
import type { Hub } from './hub.ts';
import { hubAt, makeProductionLayers, settings, type Settings } from './services.ts';
import type { Run } from './workflow.ts';

const secrets = ['AGENTGRAPH_APP_KEY', 'AGENTGRAPH_PROXY_KEYS'];
const readText = (file: string) => readFile(file.replace(/^~(?=\/|$)/, homedir()), 'utf8');

export const readEnvFile = async (file: string | undefined): Promise<Record<string, string>> =>
  file ? (parseEnv(await readText(file)) as Record<string, string>) : {};

const readSecretFiles = async (vars: Record<string, string | undefined>) => ({
  ...vars,
  ...Object.fromEntries(
    await Promise.all(
      secrets.filter(name => vars[`${name}_FILE`]).map(async name => [name, await readText(vars[`${name}_FILE`]!)])
    )
  ),
});

export const readEngineEnv = async (defaults: Record<string, string> = {}): Promise<Record<string, string>> => {
  const app = await readEnvFile(process.env.AGENTGRAPH_APP_ENV ?? defaults.AGENTGRAPH_APP_ENV);
  const layers = [defaults, process.env, app];
  const merged = Object.assign({}, ...(await Promise.all(layers.map(readSecretFiles))));
  return Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined));
};

export const writeTriggeringIssue = async (
  hub: Hub,
  forge: string,
  text: string,
  author: string,
  workflow?: string
): Promise<number> => {
  const labelled = Object.values(hub.workflows).flatMap(w => (w.on.issues?.label ? [[w.name, w.on.issues.label]] : []));
  const picked = labelled.filter(([name]) => (workflow ?? name) === name);
  const label = picked.length === 1 ? picked[0]![1]! : undefined;
  if (!label)
    throw new Error(`name one workflow with a label: --workflow ${picked.map(([name]) => name).join('|') || '<name>'}`);
  if (labelled.filter(([, l]) => l === label).length > 1) throw new Error(`${label} starts more than one workflow`);
  if (author.endsWith('[bot]') || (hub.trust && !hub.trust.includes(author)))
    throw new Error(`${author} may not start runs on this hub`);
  const [title = '', ...body] = text.split('\n');
  const milestone = hub.milestone && { milestone: hub.milestone };
  return writeIssueFile(forge, { title, author, labels: [label], ...milestone }, body.join('\n').trim());
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

const configured = (env: Record<string, string>, extra: Record<string, string> = {}) =>
  ConfigProvider.fromMap(new Map(Object.entries({ ...env, ...extra })));

/**
 * Reads the settings, the App env file named by `AGENTGRAPH_APP_ENV` and the environment, builds the services, catches up
 * with one sweep and then ticks every `every` minutes. With `one`, it looks at that issue once, or at every open issue once when `issue` is
 * `'all'`, and resolves with the runs it touched. The only place that leaves Effect.
 */
export const start = (
  one?: { hub: string; issue: number | 'all'; data: string; instruction?: Instruction },
  services: (s: Settings) => Layer.Layer<Services> = makeProductionLayers,
  defaults: Record<string, string> = {}
): Promise<Run[]> => {
  const provided = <A, E>(effect: Effect.Effect<A, E, Services>) =>
    Effect.provide(effect, Layer.unwrapEffect(Effect.map(settings, services)));
  const read = Effect.promise(() => readEngineEnv(defaults));
  const program = one
    ? Effect.gen(function* () {
        const env = yield* read;
        const hub = yield* readConfiguredHub(one.hub).pipe(Effect.withConfigProvider(configured(env)));
        const provider = configured(env, {
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
              : tick(hub, one.issue, one.marked)
        ).pipe(Effect.withConfigProvider(provider));
      })
    : Effect.gen(function* () {
        const provider = configured(yield* read);
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
        yield* provided(loop).pipe(Effect.withConfigProvider(provider));
        return [];
      });
  return Effect.runPromise(program);
};
