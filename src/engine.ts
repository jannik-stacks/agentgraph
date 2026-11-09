import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, type Layer, Schema, Stream } from 'effect';
import { parseLabels, readRunLabels, writeRunLabels } from './labels.ts';
import type { Applied } from './event.ts';
import { PluginMetadata } from './meta.ts';
import { readRealPath } from './instance.ts';
import type { Graph } from './folder.ts';
import type * as MainModule from './main.ts';
import type { JsonValue } from './meta.ts';
import { fileStore, readJsonlRows, readRecordSync, Store } from './store.ts';
import { Tracker, TrackerError, writeAgentComment } from './tracker.ts';
import { type CheckEntry, findLatestChecks } from './trace.ts';
import type { RunRecord } from './workflow.ts';

type EngineConfig = {
  readonly name: string;
  readonly data: string;
  readonly instance?: string;
  readonly checks?: Graph['checks'];
};

type StoredRun = {
  readonly data: string;
  readonly run: RunRecord;
  readonly labels: Readonly<Record<string, string>>;
  readonly latest: readonly CheckEntry[];
};

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

export type InstanceHost = {
  readonly store: Pick<Store['Service'], 'listRecords' | 'getRecord' | 'read' | 'readChecks' | 'readLog'>;
  readonly tracker: Pick<Tracker['Service'], 'issues' | 'issue' | 'since'>;
  readonly readRuns: () => StoredRun[];
  readonly say: (issue: number, text: string) => Effect.Effect<Applied, TrackerError>;
  readonly label: (
    id: string,
    patch: Parameters<typeof writeRunLabels>[2]
  ) => Effect.Effect<Effect.Success<ReturnType<typeof writeRunLabels>>, unknown>;
};

export const makeInstanceHost = (
  { data, checks = {} }: Pick<EngineConfig, 'data' | 'checks'>,
  tracker?: { layer: Layer.Layer<Tracker>; local: boolean }
): InstanceHost => {
  const store = Effect.runSync(Store.pipe(Effect.provide(fileStore(data))));
  const versions = Object.fromEntries(Object.entries(checks).map(([check, c]) => [check, c.version]));
  const missing = new TrackerError({ message: 'this studio serves no tracker' });
  const provided = <A>(effect: Effect.Effect<A, TrackerError, Tracker>) =>
    tracker ? Effect.provide(effect, tracker.layer) : Effect.fail(missing);
  return {
    store,
    tracker: {
      issues: filter => provided(Effect.flatMap(Tracker, t => t.issues(filter))),
      issue: n => provided(Effect.flatMap(Tracker, t => t.issue(n))),
      since: (cursor, columns) =>
        tracker
          ? Stream.unwrap(Effect.map(Tracker, t => t.since(cursor, columns))).pipe(Stream.provide(tracker.layer))
          : Stream.fail(missing),
    },
    readRuns: () => (existsSync(data) ? readdirSync(data) : []).flatMap(id => readStoredRun(data, id, versions) ?? []),
    say: (issue, text) =>
      tracker && !tracker.local
        ? Effect.fail(new TrackerError({ message: 'comment on the tracker; this host does not post there' }))
        : provided(writeAgentComment(issue, text)),
    label: (id, patch) =>
      Effect.flatMap(store.getRecord(id), run =>
        run ? writeRunLabels(data, id, patch) : Effect.fail(new Error(`no run ${id}`))
      ),
  };
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
    readRuns: name => makeInstanceHost(pick(name)).readRuns(),
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
