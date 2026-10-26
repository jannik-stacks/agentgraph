import { existsSync, readdirSync, watch } from 'node:fs';
import type { ServerResponse } from 'node:http';
import { basename, join } from 'node:path';
import type { Plugin } from 'vite';
import { type Fixture, scenarios, simulate } from './src/graph/scenarios.ts';
import { findTraceLinks, mergeCheckEntries } from './src/runs/trace.ts';
import type * as BenchModule from '../bin/bench.ts';
import type * as ResultsModule from '../bin/results.ts';
import type * as DriveModule from '../bench/drive.ts';
import type * as HarnessesModule from '../src/harnesses.ts';
import type * as StoreModule from '../src/store.ts';
import type * as WorkflowModule from '../src/workflow.ts';
import type * as FixturesModule from '../tests/fixtures.ts';

const id = 'virtual:fixtures';
const root = new URL('../', import.meta.url);
const from = <T>(path: string): Promise<T> => import(new URL(path, root).href);

/** The served graph as the engine loads it: the graph, or the problems that stop it loading. */
const servedGraph = async () => {
  const dir = process.env.VITE_AGI_DIR;
  if (!dir) return;
  const { Effect, Either } = await import('effect');
  const { makeHarnessConfigProvider, readConfiguredGraph }: typeof HarnessesModule = await from('src/harnesses.ts');
  const choice = JSON.parse(process.env.VITE_AGI_HARNESS_CHOICE ?? '{}');
  const loaded = await Effect.runPromise(
    Effect.either(readConfiguredGraph(dir).pipe(Effect.withConfigProvider(makeHarnessConfigProvider(choice))))
  );
  return Either.isRight(loaded)
    ? { name: basename(dir), graph: loaded.right, problems: [] }
    : { name: basename(dir), graph: undefined, problems: loaded.left.problems };
};

const json = (res: ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

/** The bench out dirs at or under `dir`: those with a `log.jsonl`, never looking into case dirs. */
const findBenchOutDirs = (dir: string, depth = 3): string[] => [
  ...(existsSync(join(dir, 'log.jsonl')) ? [dir] : []),
  ...(depth && existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !/^(\.|engine$)/.test(e.name) && !existsSync(join(dir, e.name, 'human')))
        .flatMap(e => findBenchOutDirs(join(dir, e.name), depth - 1))
    : []),
];

/** The driven bench dirs at or right under `dir`: those with a `set.json`. */
const findDrivenBenchDirs = (dir: string): string[] => [
  ...(existsSync(join(dir, 'set.json')) ? [dir] : []),
  ...(existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'set.json')))
        .map(e => join(dir, e.name))
    : []),
];

/** A JSON value with every string longer than a line cut to one. */
const cut = (value: unknown): unknown =>
  typeof value === 'string'
    ? value.length > 160
      ? `${value.slice(0, 160)}...`
      : value
    : Array.isArray(value)
      ? value.map(cut)
      : value && typeof value === 'object'
        ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, cut(v)]))
        : value;

const bodies = (docs: Record<string, { body: string }>) =>
  Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, doc.body]));

/**
 * Serves the fixture workflows, each with runs replayed through the engine's begin and transition, as
 * `virtual:fixtures`, plus the served graph's workflows. `GET /api/runs` answers that graph's runs in the data dir with
 * their traces, every text in them cut short; `GET /api/runs/<id>` answers one run with every trace line, and
 * `GET /api/logs/<hash>` the full output of a check, and `GET /api/locate?gh=<link or comment id>` what `locate` finds.
 * `GET /api/bench` answers the rows of every bench out dir under the dirs `VITE_AGI_BENCH` names, where each driven
 * bench dir stands.
 * `GET /api/results?from=runs|bench|tune` answers what each run, bench row or tune candidate gave, with its fields (`bin/results.ts`);
 * tunes are under `VITE_AGI_TUNE` (default: the `bin/tune.ts` root).
 * `GET /api/events` is a server-sent event stream that says `changed` when anything in the data dir does.
 */
export const makeStudioDevApiPlugin = (): Plugin => ({
  name: 'agentgraph:fixtures',
  resolveId: source => (source === id ? `\0${id}` : undefined),
  configureServer(server) {
    server.middlewares.use('/api/events', (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': open\n\n');
      const data = process.env.VITE_AGI_DATA;
      if (!data || !existsSync(data)) return;
      let timer: ReturnType<typeof setTimeout> | undefined;
      const watcher = watch(data, { recursive: true }, () => {
        clearTimeout(timer);
        timer = setTimeout(() => res.write('data: changed\n\n'), 150);
      });
      req.on('close', () => {
        clearTimeout(timer);
        watcher.close();
      });
    });
    server.middlewares.use('/api/bench', async (_req, res) => {
      const { readBenchRows }: typeof BenchModule = await from('bin/bench.ts');
      const { readBenchDriveState }: typeof DriveModule = await from('bench/drive.ts');
      const dirs = (process.env.VITE_AGI_BENCH ?? '').split(':').filter(Boolean);
      json(res, {
        rows: dirs.flatMap(dir => findBenchOutDirs(dir)).flatMap(out => readBenchRows(out)),
        drives: [...new Set(dirs.flatMap(findDrivenBenchDirs))].map(readBenchDriveState),
      });
    });
    server.middlewares.use('/api/results', (req, res) => {
      const source = new URL(req.url ?? '/', 'http://studio').searchParams.get('from');
      if (source !== 'runs' && source !== 'bench' && source !== 'tune') return json(res, { error: 'bad from' }, 400);
      const dirs = {
        ...(process.env.VITE_AGI_DATA && { data: process.env.VITE_AGI_DATA }),
        bench: (process.env.VITE_AGI_BENCH ?? '').split(':').filter(Boolean),
        benchOuts: (dir: string) => findBenchOutDirs(dir),
        ...(process.env.VITE_AGI_TUNE && { tune: process.env.VITE_AGI_TUNE }),
      };
      void Promise.all([from<typeof ResultsModule>('bin/results.ts'), servedGraph()]).then(
        ([{ readRunResults }, served]) => json(res, readRunResults(source, dirs, served?.graph)),
        (e: Error) => json(res, { error: e.message }, 500)
      );
    });
    server.middlewares.use('/api/logs', async (req, res) => {
      const data = process.env.VITE_AGI_DATA;
      const { Effect } = await import('effect');
      const { Store, fileStore }: typeof StoreModule = await from('src/store.ts');
      const hash = (req.url ?? '/').split('?')[0]!.slice(1);
      const text =
        data &&
        (await Effect.runPromise(Effect.flatMap(Store, s => s.readLog(hash)).pipe(Effect.provide(fileStore(data)))));
      res.statusCode = text === undefined || text === '' ? 404 : 200;
      res.setHeader('content-type', 'text/plain; charset=utf-8');
      res.end(text || '');
    });
    server.middlewares.use('/api/locate', async (req, res) => {
      const data = process.env.VITE_AGI_DATA;
      const { Effect, Either } = await import('effect');
      const { fileStore, locate }: typeof StoreModule = await from('src/store.ts');
      if (!data) return json(res, null, 404);
      const gh = new URL(req.url ?? '/', 'http://studio').searchParams.get('gh');
      const found = await Effect.runPromise(Effect.either(locate({ gh })).pipe(Effect.provide(fileStore(data))));
      if (Either.isLeft(found)) return json(res, { error: found.left.message }, 400);
      json(res, found.right ?? null, found.right ? 200 : 404);
    });
    server.middlewares.use('/api/runs', async (req, res) => {
      const served = await servedGraph();
      const data = process.env.VITE_AGI_DATA;
      const one = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1));
      if (one && !/^(?!\.+$)[\w.-]+$/.test(one)) return json(res, { error: 'bad run id' }, 400);
      const { Effect, Stream, Chunk } = await import('effect');
      const { Store, fileStore }: typeof StoreModule = await from('src/store.ts');
      if (!served || !data) return json(res, one ? null : []);
      const answer = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const entry = (run: WorkflowModule.Run, all: boolean) =>
            Effect.zipWith(Stream.runCollect(store.read(run.id)), store.readChecks(run.id), (chunk, checks) => {
              const trace = Chunk.toArray(chunk);
              const lines = mergeCheckEntries(trace, checks);
              return {
                fixture: `${served.name}/${run.workflow}`,
                repo: served.graph?.repo ?? '',
                run,
                trace: all ? lines : lines.map(line => cut(line) as typeof line),
                ...findTraceLinks(trace),
              };
            });
          if (!one) return yield* Effect.forEach(yield* store.list(), run => entry(run, false));
          const run = yield* store.get(one);
          return run ? yield* entry(run, true) : null;
        }).pipe(Effect.provide(fileStore(data)))
      );
      json(res, answer, answer === null ? 404 : 200);
    });
  },
  async load(source) {
    if (source !== `\0${id}`) return;
    const { graphs, fixture }: typeof FixturesModule = await from('tests/fixtures.ts');
    const engine: typeof WorkflowModule = await from('src/workflow.ts');
    const all: Fixture[] = graphs.flatMap(graph => {
      const { checks, workflows } = fixture(graph);
      return Object.values(workflows).map(workflow => ({
        id: `${graph}/${workflow.name}`,
        workflow: { ...workflow, path: `${graph}/workflows/${workflow.name}.md` },
        checks,
        runs: scenarios(workflow, checks).map(({ label, next }) => ({ label, ...simulate(workflow, next, engine) })),
      }));
    });
    const served = await servedGraph();
    const graph = served?.graph;
    const real: Fixture[] = Object.values(graph?.workflows ?? {}).map(workflow => ({
      id: `${served!.name}/${workflow.name}`,
      workflow,
      checks: graph!.checks,
      runs: [],
      agents: bodies(graph!.agents),
      skills: bodies(graph!.skills),
      roles: Object.fromEntries(
        Object.entries(graph!.agents).map(([name, a]) => [
          name,
          { returns: a.returns, ...(a.reads && { reads: a.reads }), ...(a.model !== undefined && { model: a.model }) },
        ])
      ),
    }));
    const shown = served && { name: served.name, problems: served.problems };
    return `export const fixtures = ${JSON.stringify([...real, ...all])};\nexport const served = ${JSON.stringify(shown ?? null)};`;
  },
});
