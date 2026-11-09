import { realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { Effect, Result, Stream } from 'effect';
import { readRequestUser } from './auth.ts';
import { makeServedGraphs, readBenchSets, readModule, readQuery, servedIds, writeJson } from './served.ts';
import { type Fixture, scenarios, simulate } from './src/graph/scenarios.ts';
import { findCheckVerdicts } from './src/graph/trail.ts';
import { findTraceLinks, makeRunSummary, mergeCheckEntries, pickListedRun } from './src/runs/trace.ts';
import type * as ResultsModule from '../bin/results.ts';
import type * as StoreModule from '../src/store.ts';
import type * as ActionsModule from '../src/actions.ts';
import type * as EngineModule from '../src/engine.ts';
import type * as ToolsModule from '../src/tools.ts';
import type * as LabelsModule from '../src/labels.ts';
import type * as WorkflowModule from '../src/workflow.ts';
import type { RunRecord } from '../src/types.ts';
import type * as FixturesModule from '../tests/fixtures.ts';

const isInside = async (path: string, roots: string[]) => {
  const [real, ...reals] = await Promise.all([path, ...roots].map(p => realpath(p).catch(() => undefined)));
  return !!real && reals.some(root => root !== undefined && real.startsWith(root + sep));
};

class StudioRequestError extends Error {}

const readPath = (req: IncomingMessage) => (req.url ?? '/').split('?')[0]!.slice(1);

const pickServed = async (req: IncomingMessage, reader: ReturnType<typeof makeServedGraphs>) => {
  const name = readQuery(req).get('instance') ?? '';
  const all = await reader.read();
  const served = all.find(one => one.name === name);
  if (!served && (name || all.some(one => one.name)))
    throw new StudioRequestError(`this studio serves no instance named "${name}"`);
  return served;
};

const readDataDir = async (req: IncomingMessage, reader: ReturnType<typeof makeServedGraphs>) => {
  const served = await pickServed(req, reader);
  const bench = readQuery(req).get('data');
  if (!bench) return { served, data: served?.data, store: served?.host?.store, bench: undefined };
  if (!(await isInside(bench, readBenchSets()))) throw new StudioRequestError('data is outside the bench dirs');
  const { makeInstanceHost } = await readModule<typeof EngineModule>('src/engine.ts');
  return { served, data: bench, store: makeInstanceHost({ data: bench }).store, bench };
};

const bodies = (docs: Record<string, { body: string }>) =>
  Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, doc.body]));

export const makeStudioDevApiPlugin = (reader = makeServedGraphs()): Plugin => {
  return {
    name: 'agentgraph:fixtures',
    resolveId: source => (servedIds.includes(source) ? `\0${source}` : undefined),
    configureServer(server) {
      const use = (path: string, handle: (req: IncomingMessage, res: ServerResponse) => Promise<unknown>) =>
        server.middlewares.use(path, (req, res) => {
          void handle(req, res).catch((e: Error & { _tag?: string }) =>
            writeJson(res, { error: e.message || e._tag }, e instanceof StudioRequestError ? 400 : 500)
          );
        });
      const handlers = new WeakMap<object, ReturnType<typeof EngineModule.makeActionWebHandler>>();
      use('/api/actions', async (req, res) => {
        if (req.method !== 'POST') return writeJson(res, { error: 'POST required' }, 405);
        if (!/^application\/(x-)?ndjson\b/.test(req.headers['content-type'] ?? ''))
          return writeJson(res, { error: 'actions take NDJSON' }, 415);
        const host = (await pickServed(req, reader))?.host;
        if (!host) return writeJson(res, { error: 'this studio serves no instance host' }, 404);
        const { readRequestBody } = await readModule<typeof ToolsModule>('src/tools.ts');
        const body = await readRequestBody(req);
        if (body === undefined) throw new StudioRequestError('the body is over 64 KiB');
        const { makeActionWebHandler } = await readModule<typeof EngineModule>('src/engine.ts');
        const { userHeader } = await readModule<typeof ActionsModule>('src/actions.ts');
        const web = handlers.get(host) ?? handlers.set(host, makeActionWebHandler(host)).get(host)!;
        const user = readRequestUser(req);
        const response = await web.handler(
          new Request('http://studio/', {
            method: 'POST',
            headers: { 'content-type': 'application/ndjson', ...(user && { [userHeader]: user }) },
            body,
          })
        );
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (!response.body) return res.end();
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res).catch(() => {});
      });
      use('/api/results', async (req, res) => {
        const { served, data } = await readDataDir(req, reader);
        const { readRunResults } = await readModule<typeof ResultsModule>('bin/results.ts');
        writeJson(res, readRunResults(data, served?.graph));
      });
      use('/api/logs', async (req, res) => {
        const { store } = await readDataDir(req, reader);
        const text = store && (await Effect.runPromise(store.readLog(readPath(req))));
        res.statusCode = text === undefined || text === '' ? 404 : 200;
        res.setHeader('content-type', 'text/plain; charset=utf-8');
        res.end(text || '');
      });
      use('/api/locate', async (req, res) => {
        const { locate } = await readModule<typeof StoreModule>('src/store.ts');
        const gh = readQuery(req).get('gh');
        for (const { name, host } of await reader.read()) {
          if (!host) continue;
          const found = await Effect.runPromise(Effect.result(locate({ gh }, host.store)));
          if (Result.isFailure(found)) return writeJson(res, { error: found.failure.message }, 400);
          if (found.success) return writeJson(res, { ...found.success, instance: name });
        }
        writeJson(res, null, 404);
      });
      use('/api/verdicts', async (req, res) => {
        const served = await pickServed(req, reader);
        const query = readQuery(req);
        const [fixture, step, check] = [query.get('fixture'), query.get('step'), query.get('check')];
        if (!fixture || !step || !check) return writeJson(res, { error: 'verdicts take fixture, step and check' }, 400);
        const store = served?.host?.store;
        if (!store) return writeJson(res, []);
        const runs = await Effect.runPromise(
          Effect.gen(function* () {
            const records = (yield* store.listRecords()).filter(run => `${served.title}/${run.workflow}` === fixture);
            return yield* Effect.forEach(records, run =>
              Effect.map(store.readChecks(run.id), checks => ({ run, checks }))
            );
          })
        );
        writeJson(res, findCheckVerdicts(runs, step, check));
      });
      use('/api/runs', async (req, res) => {
        const { served, data, store, bench } = await readDataDir(req, reader);
        const one = decodeURIComponent(readPath(req));
        if (one && !/^(?!\.+$)[\w.-]+$/.test(one)) return writeJson(res, { error: 'bad run id' }, 400);
        const { readRunLabels }: typeof LabelsModule = await readModule('src/labels.ts');
        if (!data || !store || (!served?.dir && !bench)) return writeJson(res, one ? null : []);
        const keep = (id: string) => Effect.promise(async () => !bench || isInside(join(data, id), [data]));
        const answer = await Effect.runPromise(
          Effect.gen(function* () {
            const entry = (run: RunRecord, all: boolean, body = false) =>
              Effect.zipWith(Stream.runCollect(store.read(run.id)), store.readChecks(run.id), (trace, checks) => {
                const lines = mergeCheckEntries(trace, checks);
                const summary = makeRunSummary(run, lines);
                const { usd, lastAt, urls } = summary;
                return {
                  fixture: `${bench ? 'bench' : served!.title}/${run.workflow}`,
                  repo: served?.graph?.repo ?? '',
                  run: all ? run : pickListedRun(run, body),
                  labels: readRunLabels(data, run.id),
                  ...(all ? { usd, lastAt, urls, trace: lines } : summary),
                  ...findTraceLinks(trace),
                  ...(bench && { data: bench }),
                };
              });
            if (!one) {
              const runs = yield* Effect.filter(yield* store.listRecords(), run => keep(run.id));
              const told = new Map<number, string>();
              for (const run of runs.toSorted((a, b) => a.started.localeCompare(b.started)))
                if (run.issue !== undefined && run.body !== undefined) told.set(run.issue, run.id);
              return yield* Effect.forEach(runs, run =>
                entry(run, false, run.issue !== undefined && told.get(run.issue) === run.id)
              );
            }
            const run = (yield* keep(one)) ? yield* store.getRecord(one) : undefined;
            return run ? yield* entry(run, true) : null;
          })
        );
        writeJson(res, answer, answer === null ? 404 : 200);
      });
    },
    async load(source) {
      if (source === '\0virtual:served') {
        const served = (await reader.read()).map(({ name, title, problems, local }) => ({
          name,
          title,
          problems,
          local,
        }));
        return {
          code: `export const served = ${JSON.stringify(served)};`,
          map: { mappings: '' },
        };
      }
      if (source !== '\0virtual:fixtures') return;
      const { graphs, fixture }: typeof FixturesModule = await readModule('tests/fixtures.ts');
      const engine: typeof WorkflowModule = await readModule('src/workflow.ts');
      const all: Fixture[] = graphs.flatMap(graph => {
        const { checks, workflows } = fixture(graph);
        return Object.values(workflows).map(workflow => ({
          id: `${graph}/${workflow.name}`,
          workflow: { ...workflow, path: `${graph}/workflows/${workflow.name}.md` },
          checks,
          runs: scenarios(workflow, checks).map(({ label, next }) => ({ label, ...simulate(workflow, next, engine) })),
        }));
      });
      const real: Fixture[] = (await reader.read()).flatMap(({ title, graph }) =>
        Object.values(graph?.workflows ?? {}).map(workflow => ({
          id: `${title}/${workflow.name}`,
          workflow,
          checks: graph!.checks,
          runs: [],
          agents: bodies(graph!.agents),
          skills: bodies(graph!.skills),
          roles: Object.fromEntries(
            Object.entries(graph!.agents).map(([name, a]) => [
              name,
              {
                returns: a.returns,
                ...(a.reads && { reads: a.reads }),
                ...(a.model !== undefined && { model: a.model }),
              },
            ])
          ),
        }))
      );
      return { code: `export const fixtures = ${JSON.stringify([...real, ...all])};`, map: { mappings: '' } };
    },
  };
};
