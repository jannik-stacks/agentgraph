import { readFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import { parseEnv } from 'node:util';
import { ConfigProvider, Effect, Exit, Layer, Scope, Schema } from 'effect';
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
import { Tracker } from './tracker.ts';
import {
  makeEnvProvider,
  makeHarnessConfigProvider,
  splitNames,
  readOverrides,
  readConfiguredGraph,
} from './harnesses.ts';
import { type Instance, readRealPath } from './instance.ts';
import { GraphSettings, type Graph } from './folder.ts';
import { getSettings } from './settings.ts';
import {
  graphAt,
  makeProductionLayers,
  type makeTrackerSetup,
  readTrackerName,
  settings,
  type Settings,
} from './services.ts';
import { writeIdleRunsCompressed, fileStore, Store, StoreError } from './store.ts';
import { LockHeldError } from './owner.ts';
import { parseLabels, writeRunLabels } from './labels.ts';
import type { Run, RunRecord } from './workflow.ts';
import type { Services } from './run/execute.ts';

export const secretSettings = ['AGENTGRAPH_APP_KEY', 'AGENTGRAPH_PROXY_KEYS'];
const readText = (file: string) => readFile(file.replace(/^~(?=\/|$)/, homedir()), 'utf8');

export const readEnvFile = async (file: string | undefined): Promise<Record<string, string>> =>
  file ? (parseEnv(await readText(file)) as Record<string, string>) : {};

export const readEngineEnv = async (
  defaults: Record<string, string> = {},
  file?: string
): Promise<Record<string, string>> => {
  const instance = await readEnvFile(file);
  const app = await readEnvFile(
    process.env.AGENTGRAPH_APP_ENV ?? instance.AGENTGRAPH_APP_ENV ?? defaults.AGENTGRAPH_APP_ENV
  );
  const layers: Record<string, string | undefined>[] = [defaults, instance, process.env, app];
  const merged = Object.assign({}, ...layers);
  for (const name of [...secretSettings, ...splitNames(merged.AGENTGRAPH_SESSION_ENV ?? '')]) {
    const file = layers.findLast(vars => vars[name] ?? vars[`${name}_FILE`])?.[`${name}_FILE`];
    if (file) merged[name] = await readText(file);
  }
  return Object.fromEntries(Object.entries(merged).filter((e): e is [string, string] => e[1] !== undefined));
};

export const readInstanceEnv = async (
  instance?: Partial<Instance>,
  choice: Parameters<typeof makeHarnessConfigProvider>[0] = {},
  defaults: Record<string, string> = {},
  tracker?: string
) => {
  const file = instance?.dir && join(dirname(instance.dir), 'config.ts');
  const env = await readEngineEnv(
    { ...(file && existsSync(file) && { AGENTGRAPH_CONFIG: file }), ...defaults },
    instance?.env
  );
  if (instance) {
    const overrides = await Effect.runPromise(
      readOverrides.pipe(Effect.provideService(ConfigProvider.ConfigProvider, makeEnvProvider(env)))
    );
    const resolved = getSettings(Schema.decodeUnknownSync(GraphSettings)({}), instance, undefined, overrides);
    Object.assign(env, {
      AGENTGRAPH_REPO: resolved.repo,
      ...(resolved.trust !== undefined && { AGENTGRAPH_TRUST: resolved.trust.join(',') }),
      ...(resolved.image !== undefined && { AGENTGRAPH_IMAGE: resolved.image }),
      AGENTGRAPH_TRACKER_DIR: instance.tracker ?? '',
      ...(instance.data && { AGENTGRAPH_DATA: instance.data }),
    });
  }
  const named = await Effect.runPromise(
    readTrackerName.pipe(Effect.provideService(ConfigProvider.ConfigProvider, makeEnvProvider(env)))
  );
  env.AGENTGRAPH_TRACKER = tracker ?? (named || instance?.trackerName || (instance ? 'folder' : ''));
  return {
    env,
    config: makeHarnessConfigProvider(
      {
        ...choice,
        provider: choice.provider ?? env.AGENTGRAPH_PROVIDER ?? instance?.provider,
      },
      makeEnvProvider(env)
    ),
  };
};

export const writeTriggeringIssue = async (
  graph: Graph,
  tracker: Layer.Layer<Tracker>,
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
  const applied = await Effect.runPromise(
    Effect.flatMap(Tracker, t =>
      t.apply(0, {
        kind: 'issue',
        ...(graph.milestone !== undefined && { milestone: graph.milestone }),
        title,
        body: body.join('\n').trim(),
        labels: [...new Set([label, ...more])],
      })
    ).pipe(Effect.provide(tracker))
  );
  if (!applied.ok || !applied.id) throw new Error(applied.reason ?? 'tracker did not return an issue number');
  return Number(applied.id);
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
  let released: Promise<void> | undefined;
  return () => (released ??= Effect.runPromise(Scope.close(scope, Exit.void)));
};

export const isLoopHeld = (data: string) =>
  createLoopLock(data).then(
    release => release().then(() => false),
    () => true
  );

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
    instance?: Instance;
    setup?: Awaited<ReturnType<typeof readInstanceEnv>> & {
      tracker: Awaited<ReturnType<typeof makeTrackerSetup>>;
    };
    choice?: Parameters<typeof makeHarnessConfigProvider>[0];
    drives?: ReturnType<typeof startLoopDrives>;
  },
  services: (s: Settings) => Layer.Layer<Services> = makeProductionLayers(one?.setup?.tracker),
  defaults: Record<string, string> = {},
  signal?: AbortSignal,
  refresh: () => Promise<unknown> = async () => {}
): Promise<RunRecord[]> => {
  const provided = <A, E, R>(effect: Effect.Effect<A, E, R>, graph?: Graph) =>
    Effect.provide(
      effect,
      Layer.unwrap(
        Effect.map(settings, s =>
          services(
            graph
              ? {
                  ...s,
                  repo: graph.repo,
                  trust: graph.trust ?? s.trust,
                  image: graph.image ?? s.image,
                }
              : s
          )
        )
      )
    );
  const read = Effect.tryPromise(() => readInstanceEnv(one?.instance, one?.choice, defaults));
  const program = one
    ? Effect.gen(function* () {
        const scope = one.setup ?? (yield* read);
        const graph = yield* readConfiguredGraph(one.graph, one.instance, {
          ...(one.base !== undefined && { base: one.base }),
        }).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config));
        const config = makeEnvProvider({
          AGENTGRAPH_REPO: graph.repo,
          AGENTGRAPH_DIR: one.graph,
          AGENTGRAPH_DATA: one.data,
        }).pipe(ConfigProvider.orElse(scope.config));
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
                })),
            graph
          ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, config));
        };
        return yield* one.drives ? runPass(one.drives, look) : look();
      })
    : Effect.gen(function* () {
        const s = yield* settings.pipe(Effect.provideService(ConfigProvider.ConfigProvider, (yield* read).config));
        yield* Effect.flatMap(Store, store => store.lock('loop')).pipe(Effect.provide(fileStore(s.data)));
        const drives = yield* Effect.acquireRelease(Effect.sync(startLoopDrives), d => Effect.promise(d.stop));
        yield* warnTemporary(s.data);
        const compress = Effect.tryPromise(() => writeIdleRunsCompressed(s.data, s.compress)).pipe(
          Effect.catch(e => Effect.logWarning(`compressing idle runs failed: ${e.cause}`))
        );
        let cursor = new Date(Date.now() - 300_000).toISOString();
        const look = <A, E>(scan: (graph: Graph, fork: Parameters<typeof tick>[5]) => Effect.Effect<A, E, Services>) =>
          Effect.flatMap(read, scope =>
            runPass(drives, fork =>
              provided(
                Effect.flatMap(settings, now => graphAt(now.graph)).pipe(Effect.flatMap(graph => scan(graph, fork)))
              )
            ).pipe(Effect.provideService(ConfigProvider.ConfigProvider, scope.config))
          );
        const poll = look((graph, fork) => scanTrackerEvents(graph, cursor, fork, drives.gates, drives.due)).pipe(
          Effect.map(next => (cursor = next)),
          Effect.catch(e => Effect.logError(e))
        );
        const pass = Effect.tryPromise(refresh).pipe(
          Effect.catch(e => Effect.logWarning(`the refresh failed, this pass keeps the last settings: ${e.cause}`)),
          Effect.andThen(
            look((graph, fork) => scanIssuesAndRunningRuns(graph, issueDebounceMs, undefined, fork, drives.gates))
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
