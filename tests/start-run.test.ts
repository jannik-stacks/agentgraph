import { Effect } from 'effect';
import { expect, it } from 'vitest';
import { Store, fileStore } from '../src/store.ts';
import { begin, type Workflow } from '../src/workflow.ts';
import { startRun } from '../src/run/start.ts';
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
