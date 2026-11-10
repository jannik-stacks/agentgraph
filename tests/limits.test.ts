import { beforeAll, describe, expect, it } from 'vitest';
import { formatLimitRaise, makeRunGraph, parseIssueLimits, type Graph } from '../src/folder.ts';
import type { Event } from '../src/event.ts';
import { runWorkflow } from '../src/run/drive.ts';
import { tick } from '../src/run/trigger.ts';
import { Effect, Layer, Stream } from 'effect';
import { Session } from '../src/session.ts';
import { folderTracker, Tracker } from '../src/tracker.ts';
import { fileStore, Store } from '../src/store.ts';
import { SessionStop } from '../src/types.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { getEventOutcome, transition } from '../src/workflow.ts';
import { fakeDocker, reply, start } from './fixtures.ts';
import { driveStored, fresh, graph, makeTestEvent, readTrace, services, w, world } from './world.ts';

const limits: Graph['limits'] = { minutes: 30, usdPerRun: 10, parallel: 2, sessions: 4, max: { usdPerRun: 60 } };
const labelled = (label: string, actor = 'morgan', trusted = true, kind: Event['kind'] = 'label') =>
  makeTestEvent({ issue: 7, kind, actor, trusted, at: '2026-11-11T10:00:00.000Z', label });
const issue = (...events: Event[]) => ({
  labels: [...new Set(events.filter(m => m.kind === 'label').map(m => m.label!))],
  events,
});

describe('issue limits', () => {
  it('keeps the graph values without labels', () => {
    expect(parseIssueLimits(limits, issue())).toEqual({ usdPerRun: { value: 10 }, minutes: { value: 30 } });
  });

  it('takes a trusted label up to max, with who set it', () => {
    expect(parseIssueLimits(limits, issue(labelled('agent:usd-per-run:40'), labelled('agent:minutes:12')))).toEqual({
      usdPerRun: {
        value: 40,
        label: { name: 'agent:usd-per-run:40', actor: 'morgan', at: '2026-11-11T10:00:00.000Z' },
      },
      minutes: { value: 12, label: { name: 'agent:minutes:12', actor: 'morgan', at: '2026-11-11T10:00:00.000Z' } },
    });
  });

  it.each([
    ['a bot or untrusted actor', [labelled('agent:usd-per-run:40', 'agentgraph[bot]', false)]],
    [
      'a label whose last change is untrusted',
      [labelled('agent:usd-per-run:40'), labelled('agent:usd-per-run:40', 'outsider', false)],
    ],
    ['a label set by no event', []],
  ])('ignores %s', (_, events) => {
    expect(parseIssueLimits(limits, { labels: ['agent:usd-per-run:40'], events })).toMatchObject({
      usdPerRun: { value: 10 },
    });
  });

  it.each([
    [
      [labelled('agent:usd-per-run:40'), labelled('agent:usd-per-run:50')],
      'agent:usd-per-run:40 and agent:usd-per-run:50 both set usd-per-run. Remove all but one.',
    ],
    [
      [labelled('agent:usd-per-run:90')],
      'agent:usd-per-run:90 is over the max usd-per-run of 60. Use 60 or less, or raise limits.max in settings.yaml and reply /agent.',
    ],
    [
      [labelled('agent:minutes:45')],
      'agent:minutes:45 is over the max minutes of 30. Use 30 or less, or raise limits.max in settings.yaml and reply /agent.',
    ],
    [[labelled('agent:usd-per-run:lots')], 'agent:usd-per-run:lots is not a number above 0.'],
    [[labelled('agent:minutes:0')], 'agent:minutes:0 is not a number above 0.'],
  ])('refuses %j', (events, why) => {
    expect(parseIssueLimits(limits, issue(...events))).toEqual({ why });
  });

  it('lets a label lower a limit below the graph value, and ignores other agent: labels', () => {
    const read = parseIssueLimits(limits, issue(labelled('agent:minutes:5'), labelled('agent:ready')));
    expect('minutes' in read && read.minutes.value).toBe(5);
  });

  it('puts the recorded values in the graph a run works with', () => {
    const graph = { limits } as Graph;
    expect(makeRunGraph(graph, { limits: { usdPerRun: { value: 40 }, minutes: { value: 12 } } }).limits).toEqual({
      ...limits,
      usdPerRun: 40,
      minutes: 12,
    });
    expect(makeRunGraph(graph, {})).toBe(graph);
  });

  it.each([
    [
      { usdPerRun: { value: 10 }, minutes: { value: 30 } },
      'usd-per-run',
      'from settings.yaml. Add agent:usd-per-run:15, up to the max of 60, to continue.',
    ],
    [
      { usdPerRun: { value: 40, label: { name: 'agent:usd-per-run:40', actor: 'm', at: '' } }, minutes: { value: 30 } },
      'usd-per-run',
      'from agent:usd-per-run:40. Replace agent:usd-per-run:40 with agent:usd-per-run:60, up to the max of 60, to continue.',
    ],
    [
      { usdPerRun: { value: 10 }, minutes: { value: 30 } },
      'minutes',
      'from settings.yaml, the max. Raise limits.max minutes in settings.yaml, then add a higher agent:minutes label to continue.',
    ],
  ] as const)('says how to raise %j %s', (run, key, text) => {
    expect(formatLimitRaise(limits, run, key)).toBe(text);
  });
});

describe('a run at its limits', () => {
  beforeAll(() => fakeDocker().restore);
  const capped = { ...graph, limits: { ...graph.limits, usdPerRun: 0.4, max: { usdPerRun: 5 } } };
  const spent = [
    start('t1'),
    { type: 'usage', input: 1, output: 1, usd: 0.5 } as const,
    reply({ kind: 'comment', body: 'Brief' }),
  ];
  const over =
    'Spent $0.50 of the $0.4 usd-per-run limit, from settings.yaml. Add agent:usd-per-run:1, up to the max of 5, to continue.';
  const label = (where: ReturnType<typeof world>, name: string, as = 'morgan') =>
    Effect.runPromise(
      Effect.flatMap(Tracker, t => Effect.andThen(t.apply(7, { kind: 'label', add: [name] }), t.issue(7))).pipe(
        Effect.provide(folderTracker(where.tracker, as))
      )
    ).then(i => i.events.at(-1)!);

  it('waits instead of stopping once its spend reaches usd-per-run, and records the limits it ran with', async () => {
    const where = world();
    const { specs, run } = services(where, [spent]);
    const waited = await run(runWorkflow(w, fresh(), capped));
    expect(waited).toMatchObject({ step: 'implement', status: 'waiting', waiting: { on: 'limits', why: over } });
    expect(waited.limits).toEqual({ usdPerRun: { value: 0.4 }, minutes: { value: 1 } });
    expect(specs).toHaveLength(1);
    const saved = readTrace(where.data, 'run-7').flatMap(t => ('saved' in t && t.saved.limits ? [t.saved.limits] : []));
    expect(saved).toEqual([{ usdPerRun: { value: 0.4 }, minutes: { value: 1 } }]);
  });

  it('goes on in the same run once a trusted label raises the limit', async () => {
    const where = world();
    const { specs, run } = services(where, [spent, [start('i1'), reply({ kind: 'ask', question: 'Done?' })]]);
    const waited = await run(runWorkflow(w, fresh(), capped));
    const raised = await label(where, 'agent:usd-per-run:3');
    const outcome = getEventOutcome(w, waited, raised)!;
    expect(outcome).toEqual({ kind: 'answer', text: '' });
    for (const other of [
      labelled('agent:needs-answer', 'agentgraph[bot]', false),
      labelled('agent:usd-per-run:3', 'outsider', false),
    ])
      expect(getEventOutcome(w, waited, other)).toBeUndefined();
    const resumed = transition(w, waited, outcome);
    expect(resumed).toMatchObject({ status: 'running', step: 'implement', tries: waited.tries });
    const asked = await run(driveStored(w, resumed, capped));
    expect(asked).toMatchObject({ id: 'run-7', status: 'waiting', reason: 'Done?' });
    expect(asked.limits?.usdPerRun).toEqual({
      value: 3,
      label: { name: 'agent:usd-per-run:3', actor: 'morgan', at: raised.at },
    });
    expect(specs.map(s => s.agent).slice(0, 2)).toEqual(['triager', 'implementor']);
  });

  it.each([
    [true, 'waiting', 'Done?'],
    [false, 'waiting', undefined],
  ])('resumes on the next pass when a label changes, trusted %s', async (trusted, status, reason) => {
    const where = world();
    const { run } = services(where, [spent, [start('i1'), reply({ kind: 'ask', question: 'Done?' })]]);
    await run(runWorkflow(w, fresh(), capped));
    await label(where, 'agent:usd-per-run:3', trusted ? 'morgan' : 'agentgraph[bot]');
    await run(tick(capped));
    const after = await run(Effect.flatMap(Store, s => s.get('run-7')));
    expect([after?.status, after?.reason, after?.waiting?.on]).toEqual([status, reason, reason ? undefined : 'limits']);
  });

  it('waits again without a session when a reply changed nothing', async () => {
    const where = world();
    const { specs, run } = services(where, [spent]);
    const waited = await run(runWorkflow(w, fresh(), capped));
    const again = await run(driveStored(w, transition(w, waited, { kind: 'answer', text: 'go on' }), capped));
    expect(again).toMatchObject({ status: 'waiting', waiting: { on: 'limits', why: over }, feedback: 'go on' });
    expect(specs).toHaveLength(1);
  });

  it('waits before setup when a label is over max, and never clamps it', async () => {
    const where = world();
    await label(where, 'agent:usd-per-run:9');
    const { specs, commands, run } = services(where, []);
    const waited = await run(runWorkflow(w, fresh(), capped));
    expect(waited).toMatchObject({
      status: 'waiting',
      waiting: {
        on: 'limits',
        why: 'agent:usd-per-run:9 is over the max usd-per-run of 5. Use 5 or less, or raise limits.max in settings.yaml and reply /agent.',
      },
    });
    expect([specs.length, commands.length, waited.limits]).toEqual([0, 0, undefined]);
  });

  it('stops a quiet workflow at its limits', async () => {
    const where = world();
    const quiet = { ...w, on: { ...w.on, feedback: {} } };
    const { run } = services(where, [spent]);
    const stopped = await run(runWorkflow(quiet, fresh(), capped));
    expect(stopped).toMatchObject({ status: 'stopped', reason: over });
  });

  it('waits on minutes after a timeout until a higher minutes label', async () => {
    const where = world();
    let opened = 0;
    const late = Layer.succeed(Session, {
      open: () => {
        opened++;
        return Stream.concat(Stream.make(start('t1')), Stream.fail(new SessionStop({ reason: 'timeout' })));
      },
    });
    const layer = Layer.mergeAll(folderTracker(where.tracker), fileStore(where.data), hostSandbox(where.origin), late);
    const drive = (r: Parameters<typeof driveStored>[1], h: Graph) =>
      Effect.runPromise(driveStored(w, r, h).pipe(Effect.provide(layer)));
    const timed: Graph = { ...capped, limits: { ...capped.limits, max: { minutes: 5 } } };
    const waited = await drive(fresh(), timed);
    const why =
      'A command ran past the 1-minute limit, from settings.yaml. Add agent:minutes:2, up to the max of 5, to continue.';
    expect(waited).toMatchObject({ status: 'waiting', waiting: { on: 'limits', why }, limits: { timeout: true } });
    const again = await drive(transition(w, waited, { kind: 'answer', text: '' }), timed);
    expect([again.waiting, opened]).toEqual([{ on: 'limits', why }, 1]);
    await label(where, 'agent:minutes:2');
    const raised = await drive(transition(w, again, { kind: 'answer', text: '' }), timed);
    expect([raised.limits?.minutes.value, raised.limits?.timeout, opened]).toEqual([2, true, 2]);
  });
});
