import { realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { basename, join, sep } from 'node:path';
import type { Plugin } from 'vite';
import { type Fixture, scenarios, simulate } from './src/graph/scenarios.ts';
import { findTraceLinks, mergeCheckEntries } from './src/runs/trace.ts';
import { resultSources } from './src/results/result.ts';
import type * as ResultsModule from '../bin/results.ts';
import type * as HarnessesModule from '../src/harnesses.ts';
import type * as StoreModule from '../src/store.ts';
import type * as LabelsModule from '../src/labels.ts';
import type * as WorkflowModule from '../src/workflow.ts';
import type * as FixturesModule from '../tests/fixtures.ts';

const id = 'virtual:fixtures';
const root = new URL('../', import.meta.url);
const from = <T>(path: string): Promise<T> => import(new URL(path, root).href);

const servedGraph = async () => {
  const dir = process.env.AGI_STUDIO_DIR;
  if (!dir) return;
  const { Effect, Either } = await import('effect');
  const { makeHarnessConfigProvider, readConfiguredGraph }: typeof HarnessesModule = await from('src/harnesses.ts');
  const choice = JSON.parse(process.env.AGI_STUDIO_HARNESS_CHOICE ?? '{}');
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

const isInside = async (path: string, roots: string[]) => {
  const [real, ...reals] = await Promise.all([path, ...roots].map(p => realpath(p).catch(() => undefined)));
  return !!real && reals.some(root => root !== undefined && real.startsWith(root + sep));
};

const readDataDir = async (req: IncomingMessage) => {
  const bench = new URL(req.url ?? '/', 'http://studio').searchParams.get('data');
  if (!bench) return { data: process.env.AGI_STUDIO_DATA, bench: undefined };
  const roots = (process.env.AGI_STUDIO_BENCH ?? '').split(':').filter(Boolean);
  return (await isInside(bench, roots)) ? { data: bench, bench } : undefined;
};

const outside = (res: ServerResponse) => json(res, { error: 'data is outside the bench dirs' }, 400);

const bodies = (docs: Record<string, { body: string }>) =>
  Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, doc.body]));

export const makeStudioDevApiPlugin = (): Plugin => ({
  name: 'agentgraph:fixtures',
  resolveId: source => (source === id ? `\0${id}` : undefined),
  configureServer(server) {
    const use = (path: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>) =>
      server.middlewares.use(path, (req, res) => {
        void handle(req, res).catch((e: Error) => json(res, { error: e.message }, 500));
      });
    use('/api/results', async (req, res) => {
      const source = resultSources.find(s => s === new URL(req.url ?? '/', 'http://studio').searchParams.get('from'));
      if (!source) return json(res, { error: 'bad from' }, 400);
      const dir = await readDataDir(req);
      if (!dir) return outside(res);
      const dirs = {
        ...(dir.data && { data: dir.data }),
        bench: (process.env.AGI_STUDIO_BENCH ?? '').split(':').filter(Boolean),
        ...(process.env.AGI_STUDIO_TUNE && { tune: process.env.AGI_STUDIO_TUNE }),
      };
      const [{ readRunResults }, served] = await Promise.all([
        from<typeof ResultsModule>('bin/results.ts'),
        servedGraph(),
      ]);
      json(res, readRunResults(source, dirs, served?.graph));
    });
    use('/api/logs', async (req, res) => {
      const dir = await readDataDir(req);
      if (!dir) return outside(res);
      const { data } = dir;
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
    use('/api/locate', async (req, res) => {
      const data = process.env.AGI_STUDIO_DATA;
      const { Effect, Either } = await import('effect');
      const { fileStore, locate }: typeof StoreModule = await from('src/store.ts');
      if (!data) return json(res, null, 404);
      const gh = new URL(req.url ?? '/', 'http://studio').searchParams.get('gh');
      const found = await Effect.runPromise(Effect.either(locate({ gh })).pipe(Effect.provide(fileStore(data))));
      if (Either.isLeft(found)) return json(res, { error: found.left.message }, 400);
      json(res, found.right ?? null, found.right ? 200 : 404);
    });
    use('/api/runs', async (req, res) => {
      const served = await servedGraph();
      const dir = await readDataDir(req);
      if (!dir) return outside(res);
      const { data, bench } = dir;
      const one = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1));
      if (one && !/^(?!\.+$)[\w.-]+$/.test(one)) return json(res, { error: 'bad run id' }, 400);
      const { Effect, Stream, Chunk } = await import('effect');
      const { Store, fileStore }: typeof StoreModule = await from('src/store.ts');
      const { readRunLabels }: typeof LabelsModule = await from('src/labels.ts');
      if (!data || (!served && !bench)) return json(res, one ? null : []);
      const keep = (id: string) => Effect.promise(async () => !bench || isInside(join(data, id), [data]));
      const answer = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const entry = (run: WorkflowModule.RunRecord, all: boolean) =>
            Effect.zipWith(Stream.runCollect(store.read(run.id)), store.readChecks(run.id), (chunk, checks) => {
              const trace = Chunk.toArray(chunk);
              const lines = mergeCheckEntries(trace, checks);
              return {
                fixture: `${bench ? 'bench' : served!.name}/${run.workflow}`,
                repo: served?.graph?.repo ?? '',
                run,
                labels: readRunLabels(data, run.id),
                trace: all ? lines : lines.map(line => cut(line) as typeof line),
                ...findTraceLinks(trace),
                ...(bench && { data: bench }),
              };
            });
          if (!one)
            return yield* Effect.forEach(yield* Effect.filter(yield* store.listRecords(), run => keep(run.id)), run =>
              entry(run, false)
            );
          const run = (yield* keep(one)) ? yield* store.getRecord(one) : undefined;
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
