import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer, Schema, Stream } from 'effect';
import { HttpRouter } from 'effect/http';
import { RpcSerialization, RpcServer } from 'effect/rpc';
import { ActionError, Actions, ActionUser, makeActionClient, userHeader } from './actions.ts';
import { parseLabels, readRunLabels, writeRunLabels, writeStoredRunLabels } from './labels.ts';
import { PluginMetadata } from './meta.ts';
import {
  findPull,
  findPullIssue,
  type Instance,
  mergePull,
  readRealPath,
  writeClosed,
  writeReview,
} from './instance.ts';
import type { Graph } from './folder.ts';
import type * as MainModule from './main.ts';
import type { JsonValue } from './meta.ts';
import type { Instruction } from './run/trigger.ts';
import { formatRunnerError } from './status.ts';
import { fileStore, readJsonlRows, readRecordSync, Store } from './store.ts';
import { findIssueDir, Tracker, type TrackerSetup, writeAgentComment } from './tracker.ts';
import { findLatestChecks } from './trace.ts';
import { type CheckEntry, type InstanceHost, type Run, type RunRecord, TrackerError } from './types.ts';

type EngineConfig = {
  readonly name: string;
  readonly data: string;
  readonly instance?: string;
  readonly checks?: Graph['checks'];
};

type StoredRun = ReturnType<InstanceHost['readRuns']>[number];

export type Submission =
  | (Required<Pick<Parameters<typeof MainModule.start>[0], 'graph' | 'setup'>> & { issue: number })
  | { import: { checkout: string; tracker: string; change: string; from?: string; issue?: string } };

export type EngineHost = {
  readonly configs: readonly EngineConfig[];
  readonly readRuns: (config: string) => StoredRun[];
  readonly submit: (
    config: string,
    origin: { job: string; version: string; input: JsonValue; labels?: Record<string, string> },
    submission: Submission
  ) => Promise<RunRecord[]>;
};

const readStoredRun = (data: string, id: string, versions: Record<string, string> = {}): StoredRun | undefined => {
  const json = readRecordSync(join(data, id, 'run.json'));
  if (!json) return undefined;
  return {
    data,
    run: JSON.parse(json) as RunRecord,
    labels: readRunLabels(data, id),
    latest: findLatestChecks(readJsonlRows(join(data, id, 'checks.jsonl')) as CheckEntry[], versions),
  };
};

const readStoredRuns = ({ data, checks = {} }: Pick<EngineConfig, 'data' | 'checks'>) => {
  const versions = Object.fromEntries(Object.entries(checks).map(([check, c]) => [check, c.version]));
  return (existsSync(data) ? readdirSync(data) : []).flatMap(id => readStoredRun(data, id, versions) ?? []);
};

export const readEngineErrors = (store: Pick<InstanceHost['store'], 'read'>, data: string, runs: readonly Run[]) =>
  Effect.map(
    Effect.forEach(
      runs.filter(run => run.status === 'waiting' && run.retried),
      run =>
        Effect.map(Stream.runCollect(store.read(run.id)), trace =>
          formatRunnerError([...trace], join(data, run.id, 'trace.jsonl'))
        )
    ),
    lines => lines.flat()
  );

export const makeInstanceHost = (
  config: Pick<EngineConfig, 'data' | 'checks'>,
  tracker?: { layer: Layer.Layer<Tracker>; origin: TrackerSetup['origin'] },
  local?: { instance: Pick<Instance, 'tracker' | 'owner'>; drive: (instruction: Instruction) => Promise<RunRecord[]> }
) => {
  const { data } = config;
  const store: InstanceHost['store'] = Effect.runSync(Store.pipe(Effect.provide(fileStore(data))));
  const service = tracker && Effect.runSync(Effect.cached(Effect.provide(Tracker, tracker.layer)));
  const missing = new TrackerError({ message: 'this studio serves no tracker' });
  const provided = <A>(effect: Effect.Effect<A, TrackerError, Tracker>) =>
    service ? Effect.flatMap(service, t => Effect.provideService(effect, Tracker, t)) : Effect.fail(missing);
  const reads: InstanceHost['tracker'] = {
    issues: filter => provided(Effect.flatMap(Tracker, t => t.issues(filter))),
    issue: n => provided(Effect.flatMap(Tracker, t => t.issue(n))),
    since: (cursor, columns) =>
      service ? Stream.unwrap(Effect.map(service, t => t.since(cursor, columns))) : Stream.fail(missing),
  };
  const host: InstanceHost = { data, store, tracker: reads, readRuns: () => readStoredRuns(config) };
  const folder = tracker?.origin.local ? dirname(tracker.origin.origin) : undefined;
  const fail = (e: unknown) => ActionError.make({ message: e instanceof Error ? e.message : String(e) });
  const attempt = <A>(act: () => Promise<A>) => Effect.tryPromise({ try: act, catch: fail });
  const refuse = Effect.fail(ActionError.make({ message: 'this host serves no instance' }));
  const owned = local && folder ? Effect.succeed(local.instance) : refuse;
  const readIssue = (n: number) =>
    Effect.map(reads.issue(n), issue => {
      const diff = folder ? join(findIssueDir(folder, n), 'diff.patch') : '';
      return { ...issue, diff: diff && existsSync(diff) ? readFileSync(diff, 'utf8') : '' };
    });
  const actions = Actions.toLayer({
    show: ({ issue }) =>
      Effect.gen(function* () {
        const runs = yield* store.list(issue === undefined ? {} : { issue });
        const pull = issue && folder ? yield* Effect.promise(() => findPull(folder, issue)) : undefined;
        const issues =
          issue === undefined
            ? yield* reads.issues()
            : yield* Effect.forEach([...new Set([issue, pull?.number ?? issue])], readIssue);
        return { issues, runs, notes: yield* readEngineErrors(store, data, runs) };
      }).pipe(Effect.mapError(fail)),
    say: ({ issue, text }) =>
      (!tracker || tracker.origin.local
        ? provided(writeAgentComment(issue, text))
        : Effect.fail(new TrackerError({ message: 'comment on the tracker; this host does not post there' }))
      ).pipe(Effect.asVoid, Effect.mapError(fail)),
    label: ({ id, patch }) => writeStoredRunLabels(data, id, patch).pipe(Effect.mapError(fail)),
    instruct: instruction => (local ? attempt(() => local.drive(instruction)) : refuse),
    review: ({ issue, verdict, text }) =>
      Effect.flatMap(owned, i => attempt(() => writeReview(i.tracker, i.owner, issue, verdict, text))),
    merge: ({ issue }) => Effect.flatMap(owned, i => attempt(() => mergePull(i, issue))),
    close: ({ issue }) =>
      Effect.gen(function* () {
        const i = yield* owned;
        const open = new Set((yield* reads.issues({ state: 'open' }).pipe(Effect.mapError(fail))).map(t => t.number));
        const [moved, pull] = yield* attempt(() => Promise.all([findPullIssue(i, issue), findPull(i.tracker, issue)]));
        const closed = [...new Set([issue, moved, pull?.number ?? issue])].filter(k => open.has(k));
        yield* Effect.forEach(closed, k => attempt(() => writeClosed(i.tracker, i.owner, k)));
        return closed;
      }),
  });
  return { ...host, actions };
};

const requireUser = Layer.succeed(ActionUser)((effect, { headers }) =>
  headers[userHeader] ? effect : Effect.fail(ActionError.make({ message: 'log in first' }))
);

export const makeActionWebHandler = (host: Pick<ReturnType<typeof makeInstanceHost>, 'actions'>) =>
  HttpRouter.toWebHandler(
    RpcServer.layerHttp({ group: Actions, path: '/', protocol: 'http' }).pipe(
      Layer.provide([host.actions, requireUser, RpcSerialization.layerNdjson])
    ),
    { disableLogger: true }
  );

export const makeLocalActionClient = (host: Pick<ReturnType<typeof makeInstanceHost>, 'actions'>) => {
  const { handler } = makeActionWebHandler(host);
  return makeActionClient('http://local/', (input, init) => {
    const request = new Request(input, init);
    request.headers.set(userHeader, 'local');
    return handler(request);
  });
};

export const makeEngineHost = (plugin: string, configs: readonly EngineConfig[], submitting = false): EngineHost => {
  const roots = new Map<string, string>();
  for (const { name, data } of configs) {
    const real = readRealPath(data);
    if (configs.filter(c => c.name === name).length > 1) throw new Error(`config ${name} is registered twice`);
    if (roots.has(real)) throw new Error(`configs ${roots.get(real)} and ${name} share the data dir ${real}`);
    roots.set(real, name);
  }
  const pick = (name: string) => {
    const config = configs.find(c => c.name === name);
    if (!config) throw new Error(`no config ${name}; registered: ${configs.map(c => c.name).join(', ') || 'none'}`);
    return config;
  };
  return {
    configs,
    readRuns: name => readStoredRuns(pick(name)),
    submit: async (name, { labels: given = {}, ...from }, submission) => {
      if (!submitting) throw new Error(`${plugin} cannot submit runs from here`);
      const { data } = pick(name);
      const labels = parseLabels(given);
      const origin = { plugin, ...from };
      const meta = Schema.decodeUnknownSync(PluginMetadata)({ engine: { origin } });
      if ('import' in submission) {
        const { writeImportedRun } = await import('./instance.ts');
        const { checkout, tracker, change, ...more } = submission.import;
        const id = await writeImportedRun({ checkout, tracker, data }, change, { ...more, ...origin });
        await Effect.runPromise(writeRunLabels(data, id, labels));
        return [readStoredRun(data, id)!.run];
      }
      if (!existsSync(submission.graph)) throw new Error(`no graph at ${submission.graph}`);
      const { start } = await import('./main.ts');
      return start({ graph: submission.graph, issue: submission.issue, setup: submission.setup, data, meta, labels });
    },
  };
};
