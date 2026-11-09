import { realpath } from 'node:fs/promises';
import type { IncomingMessage, ServerResponse } from 'node:http';
import { join, sep } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import type { Plugin } from 'vite';
import { Effect, Result, Stream } from 'effect';
import { readRequestUser } from './auth.ts';
import { makeServedGraphs, readModule, readQuery, servedIds, writeJson } from './served.ts';
import { type Fixture, scenarios, simulate } from './src/graph/scenarios.ts';
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

const isInside = async (path: string, roots: readonly string[]) => {
  const [real, ...reals] = await Promise.all([path, ...roots].map(p => realpath(p).catch(() => undefined)));
  return !!real && reals.some(root => root !== undefined && (real === root || real.startsWith(root + sep)));
};

class StudioRequestError extends Error {}

const readDataDir = async (
  req: IncomingMessage,
  reader: ReturnType<typeof makeServedGraphs>,
  readStores: () => Promise<readonly string[]>
) => {
  const watched = readQuery(req).get('data');
  if (watched) {
    if (!(await isInside(watched, await readStores())))
      throw new StudioRequestError('data is outside the stores the studio pages read');
    const { makeInstanceHost } = await readModule<typeof EngineModule>('src/engine.ts');
    return { served: undefined, data: watched, host: makeInstanceHost({ data: watched }), watched };
  }
  const name = readQuery(req).get('instance') ?? '';
  const all = await reader.read();
  const served = all.find(one => one.name === name);
  if (!served && (name || all.some(one => one.name)))
    throw new StudioRequestError(`this studio serves no instance named "${name}"`);
  return { served, data: served?.data, host: served?.host, watched: undefined };
};

const bodies = (docs: Record<string, { body: string }>) =>
  Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, doc.body]));

export const makeStudioDevApiPlugin = (
  reader = makeServedGraphs(),
  readStores: () => Promise<readonly string[]> = async () => []
): Plugin => {
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
        const { served, data, host, watched } = await readDataDir(req, reader, readStores);
        if (!host) return writeJson(res, { error: 'this studio serves no instance host' }, 404);
        const { store } = host;
        const { readRequestBody } = await readModule<typeof ToolsModule>('src/tools.ts');
        const body = await readRequestBody(req);
        if (body === undefined) throw new StudioRequestError('the body is over 64 KiB');
        let web = handlers.get(host);
        if (!web) {
          const { makeActionWebHandler } = await readModule<typeof EngineModule>('src/engine.ts');
          const { ActionError } = await readModule<typeof ActionsModule>('src/actions.ts');
          const { readRunLabels }: typeof LabelsModule = await readModule('src/labels.ts');
          const { readRunResults } = await readModule<typeof ResultsModule>('bin/results.ts');
          const results = () => Effect.sync(() => readRunResults(data, served?.graph));
          const keep = (id: string) => Effect.promise(async () => !watched || isInside(join(data!, id), [data!]));
          const entry = (run: RunRecord, all: boolean, body = false) =>
            Effect.zipWith(Stream.runCollect(store.read(run.id)), store.readChecks(run.id), (trace, checks) => {
              const lines = mergeCheckEntries(trace, checks);
              const { trail, ...summary } = makeRunSummary(run, lines);
              return {
                fixture: `${watched ? 'store' : served!.title}/${run.workflow}`,
                repo: served?.graph?.repo ?? '',
                run: all ? run : pickListedRun(run, body),
                labels: readRunLabels(data!, run.id),
                ...summary,
                ...(all ? { trace: lines } : { trail }),
                ...findTraceLinks(trace),
                ...(watched ? { data: watched } : served?.name ? { instance: served.name } : {}),
              };
            });
          const runs = ({ id }: { id?: string }) =>
            Effect.gen(function* () {
              if (!served?.dir && !watched) return id === undefined ? [] : null;
              if (id === undefined) {
                const runs = yield* Effect.filter(yield* store.listRecords(), run => keep(run.id));
                const told = new Map<number, string>();
                for (const run of runs.toSorted((a, b) => a.started.localeCompare(b.started)))
                  if (run.issue !== undefined && run.body !== undefined) told.set(run.issue, run.id);
                return yield* Effect.forEach(runs, run =>
                  entry(run, false, run.issue !== undefined && told.get(run.issue) === run.id)
                );
              }
              if (!/^(?!\.+$)[\w.-]+$/.test(id)) return yield* Effect.fail(new Error('bad run id'));
              const run = (yield* keep(id)) ? yield* store.getRecord(id) : undefined;
              return run ? yield* entry(run, true) : null;
            }).pipe(Effect.mapError(e => ActionError.make({ message: e.message })));
          web = makeActionWebHandler(host, { results, runs }, !!watched);
          handlers.set(host, web);
        }
        const response = await web(
          new Request('http://studio/', { method: 'POST', headers: { 'content-type': 'application/ndjson' }, body }),
          readRequestUser(req)
        );
        res.statusCode = response.status;
        response.headers.forEach((value, key) => res.setHeader(key, value));
        if (!response.body) return res.end();
        await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), res).catch(() => {});
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
