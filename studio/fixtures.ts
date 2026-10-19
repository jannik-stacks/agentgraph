import { existsSync, watch } from 'node:fs';
import { basename } from 'node:path';
import type { Plugin } from 'vite';
import { type Fixture, scenarios, simulate } from './src/graph/scenarios.ts';

const id = 'virtual:fixtures';
const root = new URL('../', import.meta.url);
const from = <T>(path: string): Promise<T> => import(new URL(path, root).href);

/** The served hub as the engine loads it: the hub, or the problems that stop it loading. */
const servedHub = async () => {
  const dir = process.env.VITE_BHM_HUB;
  if (!dir) return;
  const { Effect, Either } = await import('effect');
  const { loadHub }: typeof import('../src/hub.ts') = await from('src/hub.ts');
  const loaded = await Effect.runPromise(Effect.either(loadHub(dir)));
  return Either.isRight(loaded)
    ? { name: basename(dir), hub: loaded.right, problems: [] }
    : { name: basename(dir), hub: undefined, problems: loaded.left.problems };
};

const json = (res: import('node:http').ServerResponse, value: unknown, status = 200) => {
  res.statusCode = status;
  res.setHeader('content-type', 'application/json');
  res.end(JSON.stringify(value));
};

const bodies = (docs: Record<string, { body: string }>) =>
  Object.fromEntries(Object.entries(docs).map(([name, doc]) => [name, doc.body]));

/**
 * Serves the fixture workflows, each with runs replayed through the engine's begin and transition, as
 * `virtual:fixtures`, plus the served hub's workflows. `GET /core/runs` answers that hub's runs in the data dir with
 * their traces, leaving out prompts and session events; `GET /core/runs/<id>` answers one run with every trace line.
 * `GET /core/events` is a server-sent event stream that says `changed` when anything in the data dir does.
 */
export const fixtures = (): Plugin => ({
  name: 'bothub:fixtures',
  resolveId: source => (source === id ? `\0${id}` : undefined),
  configureServer(server) {
    server.middlewares.use('/core/events', (req, res) => {
      res.writeHead(200, {
        'content-type': 'text/event-stream',
        'cache-control': 'no-cache',
        connection: 'keep-alive',
      });
      res.write(': open\n\n');
      const data = process.env.VITE_BHM_DATA;
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
    server.middlewares.use('/core/runs', async (req, res) => {
      const served = await servedHub();
      const data = process.env.VITE_BHM_DATA;
      const one = decodeURIComponent((req.url ?? '/').split('?')[0]!.slice(1));
      if (one && !/^(?!\.+$)[\w.-]+$/.test(one)) return json(res, { error: 'bad run id' }, 400);
      const { Effect, Stream, Chunk } = await import('effect');
      const { Store, fileStore }: typeof import('../src/store.ts') = await from('src/store.ts');
      if (!served || !data) return json(res, one ? null : []);
      const answer = await Effect.runPromise(
        Effect.gen(function* () {
          const store = yield* Store;
          const entry = (run: import('../src/workflow.ts').Run, all: boolean) =>
            Stream.runCollect(
              store.read(run.id).pipe(Stream.filter(line => all || !('event' in line || 'prompt' in line)))
            ).pipe(
              Effect.map(trace => ({
                fixture: `${served.name}/${run.workflow}`,
                repo: served.hub?.repo ?? '',
                run,
                trace: Chunk.toArray(trace),
              }))
            );
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
    const { hubs, fixture }: typeof import('../tests/fixtures.ts') = await from('tests/fixtures.ts');
    const engine: typeof import('../src/workflow.ts') = await from('src/workflow.ts');
    const all: Fixture[] = hubs.flatMap(hub => {
      const { checks, workflows } = fixture(hub);
      return Object.values(workflows).map(workflow => ({
        id: `${hub}/${workflow.name}`,
        workflow: { ...workflow, path: `${hub}/workflows/${workflow.name}.md` },
        checks,
        runs: scenarios(workflow, checks).map(({ label, next }) => ({ label, ...simulate(workflow, next, engine) })),
      }));
    });
    const served = await servedHub();
    const hub = served?.hub;
    const real: Fixture[] = Object.values(hub?.workflows ?? {}).map(workflow => ({
      id: `${served!.name}/${workflow.name}`,
      workflow,
      checks: hub!.checks,
      runs: [],
      agents: bodies(hub!.agents),
      skills: bodies(hub!.skills),
      roles: Object.fromEntries(
        Object.entries(hub!.agents).map(([name, a]) => [
          name,
          { returns: a.returns, ...(a.reads && { reads: a.reads }) },
        ])
      ),
    }));
    const shown = served && { name: served.name, problems: served.problems };
    return `export const fixtures = ${JSON.stringify([...real, ...all])};\nexport const served = ${JSON.stringify(shown ?? null)};`;
  },
});
