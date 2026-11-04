import { readFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigProvider, Effect, Exit, Layer, Scope } from 'effect';
import {
  instruct,
  issueDebounceMs,
  runPass,
  scanIssuesAndRunningRuns,
  scanTrackerEvents,
  startLoopDrives,
  tick,
  type Instruction,
} from './run/trigger.ts';
import { writeIssueFile, type TrackerError } from './tracker.ts';
import { makeEnvProvider, makeHarnessConfigProvider, splitNames, readConfiguredGraph } from './harnesses.ts';
import { readRealPath } from './instance.ts';
import type { Graph } from './folder.ts';
import { graphAt, makeProductionLayers, settings, type Settings } from './services.ts';
import { writeIdleRunsCompressed, fileStore, Store, StoreError } from './store.ts';
import { LockHeldError } from './owner.ts';
import { parseLabels, writeRunLabels } from './labels.ts';
import type { Run, RunRecord } from './workflow.ts';
import type { Services } from './run/execute.ts';

export const secretSettings = ['AGENTGRAPH_APP_KEY', 'AGENTGRAPH_PROXY_KEYS'];
const readText = (file: string) => readFile(file.replace(/^~(?=\/|$)/, homedir()), 'utf8');

export const readEnvFile = async (file: string | undefined): Promise<Record<string, string>> =>
  file ? (parseEnv(await readText(file)) as Record<string, string>) : {};

export const readEngineEnv = async (defaults: Record<string, string> = {}): Promise<Record<string, string>> => {
  const app = await readEnvFile(process.env.AGENTGRAPH_APP_ENV ?? defaults.AGENTGRAPH_APP_ENV);
  const layers: Record<string, string | undefined>[] = [defaults, process.env, app];
  const merged = Object.assign({}, ...layers);
  for (const name of [...secretSettings, ...splitNames(merged.AGENTGRAPH_SESSION_ENV ?? '')]) {
    const file = layers.findLast(vars => vars[name] ?? vars[`${name}_FILE`])?.[`${name}_FILE`];
    if (file) merged[name] = await readText(file);
  }
  return Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined));
};

export const writeTriggeringIssue = async (
  graph: Graph,
  tracker: string,
  text: string,
  author: string,
  workflow?: string,
  more: string[] = []
): Promise<number> => {
  const labelled = Object.values(graph.workflows).flatMap(w =>
    w.on.issues?.label ? [[w.name, w.on.issues.label]] : []
  );
  const picked = labelled.filter(([name]) => (workflow ?? name) === name);
  const label = picked.length === 1 ? picked[0]![1]! : undefined;
  if (!label)
    throw new Error(`name one workflow with a label: --workflow ${picked.map(([name]) => name).join('|') || '<name>'}`);
  if (labelled.filter(([, l]) => l === label).length > 1) throw new Error(`${label} starts more than one workflow`);
  if (author.endsWith('[bot]') || (graph.trust && !graph.trust.includes(author)))
    throw new Error(`${author} may not start runs on this graph`);
  const [title = '', ...body] = text.split('\n');
  const milestone = graph.milestone && { milestone: graph.milestone };
  return writeIssueFile(
    tracker,
    { title, author, labels: [...new Set([label, ...more])], ...milestone },
    body.join('\n').trim()
  );
};

/** The data dir and its mirror, where they sit under a temp dir the OS may empty. */
export const temporary = (data: string): string[] => {
  const temps = [...new Set(['/tmp', tmpdir()].flatMap(d => [resolve(d), readRealPath(d)]))];
  return [data, join(data, 'mirror.git')].filter(p =>
    [resolve(p), readRealPath(p)].some(at => temps.some(t => at === t || at.startsWith(t + sep)))
  );
};

const warnTemporary = (data: string) =>
  Effect.forEach(temporary(data), p => Effect.logWarning(`${p} is under a temp dir, which the OS may empty`));

const configured = (env: Record<string, string>, extra: Record<string, string> = {}) =>
  makeEnvProvider({ ...env, ...extra });

const failLoopLock = (error: unknown): never => {
  const cause = error instanceof StoreError ? error.cause : undefined;
  throw cause instanceof LockHeldError ? cause : error;
};

export const createLoopLock = async (data: string) => {
  const scope = Effect.runSync(Scope.make());
  await Effect.runPromise(
    Effect.flatMap(Store, s => s.lock('loop')).pipe(Effect.provide(fileStore(data)), Scope.provide(scope))
  ).catch(async (e: unknown) => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    failLoopLock(e);
  });
  return () => Effect.runPromise(Scope.close(scope, Exit.void));
};

export const isLoopHeld = (data: string) =>
  createLoopLock(data).then(
    release => release().then(() => false),
    () => true
  );

/**
 * Reads the settings, the App env file named by `AGENTGRAPH_APP_ENV` and the environment, builds the services, catches up
 * with one sweep and then ticks every `every` minutes under the data dir's loop lock. Each pass first runs `refresh`,
 * then reads the settings and builds the services again, so a renewed login reaches it without a restart. With `one`,
 * it looks at that issue once, or at every open issue once when `issue` is `'all'`, and resolves with the runs it
 * touched; `base` is the branch workflows that name none start from, and `labels` go on each run it begins. An abort of `signal` interrupts it, and a run it drove resumes on the next look.
 */
export const start = (
  one?: {
    graph: string;
    issue: number | 'all';
    data: string;
    instruction?: Instruction;
    meta?: Run['meta'];
    labels?: ReturnType<typeof parseLabels>;
    marked?: true;
    base?: string;
    choice?: Parameters<typeof makeHarnessConfigProvider>[0];
    drives?: ReturnType<typeof startLoopDrives>;
  },
  services: (s: Settings) => Layer.Layer<Services> = makeProductionLayers(),
  defaults: Record<string, string> = {},
  signal?: AbortSignal,
  refresh: () => Promise<unknown> = async () => {}
): Promise<RunRecord[]> => {
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>) =>
    Effect.provide(effect, Layer.unwrap(Effect.map(settings, services)));
  const read = Effect.tryPromise(() => readEngineEnv(defaults));
  const program = one
    ? Effect.gen(function* () {
        const env = yield* read;
        const choose = (fallback: ConfigProvider.ConfigProvider) =>
          Effect.provideService(ConfigProvider.ConfigProvider, makeHarnessConfigProvider(one.choice ?? {}, fallback));
        const loaded = yield* readConfiguredGraph(one.graph).pipe(choose(configured(env)));
        const base = one.base;
        const graph = base
          ? {
              ...loaded,
              workflows: Object.fromEntries(
                Object.entries(loaded.workflows).map(([name, w]) => [name, { base, ...w }])
              ),
            }
          : loaded;
        const provider = configured(env, {
          AGENTGRAPH_REPO: graph.repo,
          AGENTGRAPH_DIR: one.graph,
          AGENTGRAPH_DATA: one.data,
        });
        yield* warnTemporary(one.data);
        const labels = parseLabels(one.labels ?? {});
        const look = (fork?: Parameters<typeof tick>[5]) => {
          const driven = one.instruction
            ? instruct(graph, one.instruction, one.meta)
            : one.issue === 'all'
              ? scanIssuesAndRunningRuns(graph, 0, one.meta, fork)
              : tick(graph, one.issue, one.marked, 0, one.meta, fork);
          return provided(
            !Object.keys(labels).length
              ? driven
              : Effect.updateService(driven, Store, store => ({
                  ...store,
                  put: run =>
                    Effect.andThen(
                      Effect.flatMap(store.get(run.id), was =>
                        was ? Effect.void : writeRunLabels(one.data, run.id, labels)
                      ),
                      store.put(run)
                    ),
                }))
          ).pipe(choose(provider));
        };
        return yield* one.drives ? runPass(one.drives, look) : look();
      })
    : Effect.gen(function* () {
        const s = yield* settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured(yield* read)));
        yield* Effect.flatMap(Store, store => store.lock('loop')).pipe(Effect.provide(fileStore(s.data)));
        const drives = yield* Effect.acquireRelease(Effect.sync(startLoopDrives), d => Effect.promise(d.stop));
        yield* warnTemporary(s.data);
        const compress = Effect.tryPromise(() => writeIdleRunsCompressed(s.data, s.compress)).pipe(
          Effect.catch(e => Effect.logWarning(`compressing idle runs failed: ${e.cause}`))
        );
        let cursor = new Date().toISOString();
        const look = <A>(
          scan: (
            graph: Graph,
            fork: Parameters<typeof tick>[5]
          ) => Effect.Effect<A, TrackerError | StoreError, Services>
        ) =>
          Effect.flatMap(read, env =>
            runPass(drives, fork =>
              provided(
                Effect.flatMap(settings, now => graphAt(now.graph)).pipe(Effect.flatMap(graph => scan(graph, fork)))
              )
            ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, configured(env)))
          );
        const poll = look((graph, fork) => scanTrackerEvents(graph, cursor, fork, drives.ticks)).pipe(
          Effect.tap(next =>
            Effect.sync(() => {
              cursor = next;
            })
          ),
          Effect.catch(e => Effect.logError(e))
        );
        const pass = Effect.tryPromise(refresh).pipe(
          Effect.catch(e => Effect.logWarning(`the refresh failed, this pass keeps the last settings: ${e.cause}`)),
          Effect.andThen(
            look((graph, fork) => scanIssuesAndRunningRuns(graph, issueDebounceMs, undefined, fork, drives.ticks))
          ),
          Effect.tap(() => Effect.sync(() => drives.settled.splice(0))),
          Effect.catch(e => Effect.logError(e))
        );
        yield* Effect.forkScoped(Effect.forever(Effect.andThen(Effect.sleep(`${s.every} minutes`), poll)));
        return yield* Effect.forever(
          Effect.andThen(Effect.andThen(compress, pass), Effect.sleep(`${s.every} minutes`))
        );
      }).pipe(Effect.scoped);
  return Effect.runPromise(program, { signal }).catch(failLoopLock);
};
