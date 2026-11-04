import { Effect, Layer } from 'effect';
import { expect, it } from 'vitest';
import { Store, StoreError, fileStore } from '../src/store.ts';
import type { Graph } from '../src/folder.ts';
import { begin, type Workflow } from '../src/workflow.ts';
import { startProposedRun, startRun } from '../src/run/start.ts';
import { tmp } from './kit.ts';

const w = {
  name: 'issue',
  steps: [{ name: 'code', does: { agent: 'coder' }, checks: [], tries: 1 }],
} as unknown as Workflow;
const run = begin(w, { id: 'issue-1-1', issue: 1, started: '2026-11-04T00:00:00.000Z' });

it('saves a new run once and finishes only the one it saves', async () => {
  const readied: string[] = [];
  const ready = (r: typeof run) => Effect.sync(() => (readied.push(r.id), { ...r, reason: 'ready' }));
  const [first, again, saved] = await Effect.runPromise(
    Effect.all([startRun(run, ready), startRun(run, ready), Effect.flatMap(Store, s => s.get(run.id))]).pipe(
      Effect.provide(fileStore(tmp('start-run')))
    )
  );
  expect({ first, again, saved, readied }).toEqual({
    first: { ...run, reason: 'ready' },
    again: undefined,
    saved: { ...run, reason: 'ready' },
    readied: [run.id],
  });
});

const graph = { workflows: { issue: w } } as unknown as Graph;
const proposal = { kind: 'run', workflow: 'issue', issue: 1 } as const;
const failing = (dir: string) =>
  Layer.effect(
    Store,
    Effect.map(Store, s => ({
      ...s,
      lock: (id: string) => Effect.fail(new StoreError({ path: id, cause: new Error('disk full') })),
    }))
  ).pipe(Layer.provide(fileStore(dir)));
const taken = (dir: string, times: number) =>
  Layer.effect(
    Store,
    Effect.map(Store, s => {
      const seen: string[] = [];
      return {
        ...s,
        getRecord: (id: string) =>
          seen.push(id) <= times ? Effect.succeed({ ...run, id, by: 'other' }) : s.getRecord(id),
      };
    })
  ).pipe(Layer.provide(fileStore(dir)));

it('starts nothing while another pass holds the id, and fails on a lock it cannot write', async () => {
  const [held, saved] = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.lock(run.id);
      return [yield* startRun(run), yield* store.getRecord(run.id)] as const;
    }).pipe(Effect.scoped, Effect.provide(fileStore(tmp('start-run'))))
  );
  const broken = await Effect.runPromise(Effect.flip(startRun(run)).pipe(Effect.provide(failing(tmp('start-run')))));
  expect({ held, saved, broken: broken.message }).toEqual({
    held: undefined,
    saved: undefined,
    broken: 'issue-1-1: disk full',
  });
});

it.each([
  ['a fresh id', 1, 'parent'],
  ['nothing', 9, undefined],
])('starts a proposed run whose id another parent took under %s', async (_, times, by) => {
  const dir = tmp('start-run');
  const started = await Effect.runPromise(
    startProposedRun(graph, { id: 'parent' }, proposal).pipe(Effect.provide(taken(dir, times)))
  );
  const saved = await Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(dir))));
  expect({ by: started?.by, saved: saved.map(r => r.by) }).toEqual({ by, saved: by ? [by] : [] });
});
