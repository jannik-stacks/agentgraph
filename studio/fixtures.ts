import { basename } from 'node:path';
import type { Plugin } from 'vite';
import { type Fixture, scenarios, simulate } from './src/graph/views/scenarios.ts';

const id = 'virtual:fixtures';
const core = new URL('../core/', import.meta.url);
const from = <T>(path: string): Promise<T> => import(new URL(path, core).href);

/** The served hub when it is in core format, with the name its workflows are listed under. */
const coreHub = async () => {
  const dir = process.env.VITE_BHM_HUB;
  if (!dir) return;
  const { Effect } = await import('effect');
  const { loadHub }: typeof import('../core/src/hub.ts') = await from('src/hub.ts');
  const hub = await Effect.runPromise(Effect.option(loadHub(dir)));
  return hub._tag === 'Some' ? { name: basename(dir), hub: hub.value } : undefined;
};

/**
 * Serves core's fixture workflows, each with runs replayed through the engine's begin and transition, as
 * `virtual:fixtures`, plus the served hub's workflows when it is in core format. `GET /core/runs` answers that hub's
 * runs in the data dir with their traces, leaving out agent events.
 */
export const fixtures = (): Plugin => ({
  name: 'bothub:fixtures',
  resolveId: source => (source === id ? `\0${id}` : undefined),
  configureServer(server) {
    server.middlewares.use('/core/runs', async (_req, res) => {
      const served = await coreHub();
      const data = process.env.VITE_BHM_DATA;
      const { Effect, Stream, Chunk } = await import('effect');
      const { Store, fileStore }: typeof import('../core/src/store.ts') = await from('src/store.ts');
      const runs =
        !served || !data
          ? []
          : await Effect.runPromise(
              Effect.gen(function* () {
                const store = yield* Store;
                return yield* Effect.forEach(yield* store.list(), run =>
                  Stream.runCollect(store.read(run.id).pipe(Stream.filter(line => !('event' in line)))).pipe(
                    Effect.map(trace => ({ fixture: `${served.name}/${run.workflow}`, run, trace: Chunk.toArray(trace) }))
                  )
                );
              }).pipe(Effect.provide(fileStore(data)))
            );
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify(runs));
    });
  },
  async load(source) {
    if (source !== `\0${id}`) return;
    const { hubs, fixture }: typeof import('../core/tests/fixtures.ts') = await from('tests/fixtures.ts');
    const engine: typeof import('../core/src/workflow.ts') = await from('src/workflow.ts');
    const all: Fixture[] = hubs.flatMap(hub => {
      const { checks, workflows } = fixture(hub);
      return Object.values(workflows).map(workflow => ({
        id: `${hub}/${workflow.name}`,
        workflow: { ...workflow, path: `${hub}/workflows/${workflow.name}.md` },
        checks,
        runs: scenarios(workflow, checks).map(({ label, next }) => ({ label, ...simulate(workflow, next, engine) })),
      }));
    });
    const served = await coreHub();
    const real: Fixture[] = Object.values(served?.hub.workflows ?? {}).map(workflow => ({
      id: `${served!.name}/${workflow.name}`,
      workflow,
      checks: served!.hub.checks,
      runs: [],
    }));
    return `export const fixtures = ${JSON.stringify([...real, ...all])};`;
  },
});
