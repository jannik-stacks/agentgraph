import { Effect, Stream } from 'effect';
import { expect, it } from 'vitest';
import { Store, fileStore } from '../src/store.ts';
import { folderTracker } from '../src/tracker.ts';
import { startRun } from '../src/run/start.ts';
import { readHeardOutcome, readIssueWithPull, writeHeardEvents } from '../src/run/hear.ts';

import type { Event } from '../src/event.ts';
import { sumHumanInteractions } from '../src/results.ts';
import { stoppedByEngine, formatWaitingOn, type Run, type Trace } from '../src/types.ts';
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
      yield* writeHeardEvents(run, [first, first, said('cli-1', 'go', first.at, 'cli')], run.started);
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

const line = (at: string, more: object): Trace => ({ at, step: 'implement', ...more }) as Trace;
const at = (minute: number) => `2026-10-16T01:${String(minute).padStart(2, '0')}:00.000Z`;
const heard = (minute: number, more: Partial<Event> = {}) =>
  line(at(minute), { spoken: { ...said(`c${minute}`, 'hi', at(minute)), ...more } });
const saved = (minute: number, state: Partial<Run>, cleared?: (keyof Run)[]) =>
  line(at(minute), { saved: state, ...(cleared && { cleared }) });

it.each([
  ['complete', [line(at(0), { inputs: { since: at(0) } })]],
  ['partial', [line(at(5), { inputs: { since: at(5) } })]],
  ['missing', []],
])('reads a run that marks its inputs as %s', (coverage, trace) => {
  expect(sumHumanInteractions([{ run: { started: at(0) }, trace }], at(30)).coverage).toBe(coverage);
});

it('counts each human action once across runs, inside each run, and only waits for people', () => {
  const first = {
    run: { started: at(0), ended: at(30) },
    trace: [
      line(at(0), { inputs: { since: at(0) } }),
      heard(0),
      heard(1, { kind: 'approved' }),
      heard(2, { review: true }),
      heard(3, { kind: 'label', label: 'ready' }),
      heard(4, { kind: 'review_requested', reviewer: 'bob' }),
      heard(5, { bot: true }),
      heard(31),
      saved(6, { status: 'waiting', reason: 'Done?' }),
      saved(10, { status: 'running' }, ['reason']),
      saved(11, { status: 'waiting', reason: `${stoppedByEngine}.` }),
      saved(12, { status: 'waiting', reason: formatWaitingOn({ id: 'child' }) }),
      saved(13, { status: 'waiting' }, ['reason']),
    ],
  };
  const second = {
    run: { started: at(0) },
    trace: [line(at(0), { inputs: { since: at(0) } }), heard(0), saved(20, { status: 'waiting', reason: 'Ship?' })],
  };
  expect(sumHumanInteractions([first, second], at(40))).toEqual({
    coverage: 'complete',
    comments: 1,
    reviews: 2,
    labels: 1,
    requests: 1,
    waitSeconds: (4 + 17 + 20) * 60,
    openWaitSeconds: 20 * 60,
  });
});

it('sends a changes-requested review back with its line comments when the review has no body', async () => {
  const run: Run = { ...fresh(), step: 'merge', status: 'waiting', seen: '2026-10-16T00:00:02.000Z' };
  const sent = '2026-10-16T00:05:00.000Z';
  const said = (id: string, kind: Event['kind'], body: string, place = {}) =>
    makeTestEvent({
      id,
      issue: 9,
      kind,
      actor: 'morgan',
      trusted: true,
      at: sent,
      comment: { id, author: 'morgan', body, at: sent, ...place },
    });
  const pull = {
    number: 9,
    title: 'fix',
    body: '',
    state: 'open' as const,
    labels: [],
    author: 'helper[bot]',
    url: '',
  };
  const events = [
    said('1', 'comment', 'throw when not ready', { path: 'signing.mdx', line: 20 }),
    said('r1', 'changes_requested', ''),
    said('2', 'comment', 'find another word', { path: 'signing.mdx', line: 52 }),
  ];
  const heard = await Effect.runPromise(
    Effect.gen(function* () {
      yield* startRun(run);
      return yield* readHeardOutcome(graph, w, run, {
        issue: { ...pull, number: 7, events: [] },
        pull: { ...pull, events },
      });
    }).pipe(Effect.provide(fileStore(tmp('heard-review'))))
  );
  expect(heard?.outcome).toEqual({
    kind: 'back',
    why: 'changes requested\nsigning.mdx:20, id 1: throw when not ready\nsigning.mdx:52, id 2: find another word',
  });
});
