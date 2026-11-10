import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { Store, fileStore } from '../src/store.ts';
import { folderTracker } from '../src/tracker.ts';
import { startRun } from '../src/run/start.ts';
import { readIssueWithPull, writeHeardEvents } from '../src/run/hear.ts';
import { tmp } from './kit.ts';
import { fresh, graph, makeTestEvent, w, world } from './world.ts';

const said = (id: string, body: string, at: string, source?: 'cli') =>
  makeTestEvent({
    id,
    issue: 7,
    kind: 'comment',
    actor: 'morgan',
    trusted: true,
    at,
    comment: { id, author: 'morgan', body, at },
    ...(source && { source }),
  });

it('records each revision of what a run hears once, after the line that says since when', async () => {
  const run = fresh();
  const first = said('c1', 'hi', '2026-10-16T00:00:02.000Z');
  const lines = await Effect.runPromise(
    Effect.gen(function* () {
      yield* startRun(run);
      yield* writeHeardEvents(run, [first, first, said('cli-1', 'go', first.at, 'cli')]);
      yield* writeHeardEvents(run, [first, { ...first, comment: { ...first.comment!, body: 'hi again' } }]);
      return yield* Stream.runCollect((yield* Store).read(run.id));
    }).pipe(Effect.provide(fileStore(tmp('heard'))))
  );
  const kept = lines.flatMap(t =>
    'inputs' in t ? [['inputs', t.inputs.since]] : 'spoken' in t ? [['spoken', t.spoken.comment?.body]] : []
  );
  expect(kept).toEqual([
    ['inputs', run.started],
    ['spoken', 'hi'],
    ['spoken', 'hi again'],
  ]);
});

it('marks a run it starts recording late as covered from then on', async () => {
  const run = fresh();
  const lines = await Effect.runPromise(
    Effect.gen(function* () {
      const store = yield* Store;
      yield* store.put(run);
      yield* writeHeardEvents(run, []);
      return yield* Stream.runCollect(store.read(run.id));
    }).pipe(Effect.provide(fileStore(tmp('heard-late'))))
  );
  const since = lines.flatMap(t => ('inputs' in t ? [t.inputs.since] : []));
  expect(since).toHaveLength(1);
  expect(since[0]! > run.started).toBe(true);
});

it('adds back only CLI lines to the timeline a run reads, so recorded tracker events appear once', async () => {
  const where = world();
  const run = fresh();
  const t = await Effect.runPromise(
    Effect.gen(function* () {
      yield* startRun(run);
      const before = yield* readIssueWithPull(w, run, graph);
      yield* writeHeardEvents(run, before.issue.events);
      yield* (yield* Store).trace(run.id, {
        at: run.started,
        step: run.step,
        spoken: said('cli-1', 'go', run.started, 'cli'),
      });
      return yield* readIssueWithPull(w, run, graph);
    }).pipe(Effect.provide([fileStore(where.data), folderTracker(where.tracker)]))
  );
  expect(t.issue.events.map(m => [m.source ?? 'tracker', m.comment?.body])).toEqual([
    ['tracker', '/agent'],
    ['cli', 'go'],
  ]);
});
