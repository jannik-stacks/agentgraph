import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { runPass, scanIssuesAndRunningRuns, scanTrackerEvents, startLoopDrives } from '../src/run/trigger.ts';
import { folderTracker, Tracker } from '../src/tracker.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionSpec } from '../src/trace.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, start } from './fixtures.ts';
import { issuePath, write, writeIssueAt } from './kit.ts';
import type { Graph } from '../src/folder.ts';
import { comment, fresh, readChecks, readTrace, say, services, world } from './world.ts';

const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
const flow = {
  ...small.workflows.issue!,
  checks: [],
  on: { ...small.workflows.issue!.on, issues: { label: 'ready' } },
  steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: [] })),
};
const asks = [start('s'), reply({ kind: 'ask', question: 'Continue?' })];

const setup = (parallel: number, holdSweep = false) => {
  const where = world();
  const graph = { ...small, workflows: { issue: flow }, limits: { ...small.limits, parallel } };
  const opened: SessionSpec[] = [];
  const { promise: held, resolve: release } = Promise.withResolvers<void>();
  const session = Layer.effect(
    Session,
    Effect.map(Session, s => ({
      open: (spec: SessionSpec) => {
        opened.push(spec);
        return opened.length === 1
          ? Stream.unwrap(
              Effect.as(
                Effect.promise(() => held),
                s.open(spec)
              )
            )
          : s.open(spec);
      },
    }))
  ).pipe(Layer.provide(replaySession([asks, asks])));
  const { promise: sweepHeld, resolve: releaseSweep } = Promise.withResolvers<void>();
  const looked: number[] = [];
  let listings = 0;
  const cursors: string[] = [];
  const { promise: holding, resolve: hold } = Promise.withResolvers<void>();
  const tracker = Layer.effect(
    Tracker,
    Effect.map(Tracker, t => ({
      ...t,
      since: (cursor, columns) => {
        cursors.push(cursor);
        return t.since(cursor, columns);
      },
      issues: filter =>
        Effect.suspend(() => {
          listings++;
          return t.issues(filter);
        }),
      issue: n =>
        Effect.suspend(() => {
          looked.push(n);
          return t.issue(n);
        }),
      apply: (...args) =>
        Effect.gen(function* () {
          if (args[0] === 7 && holdSweep && args[1].kind === 'react') {
            hold();
            yield* Effect.promise(() => sweepHeld);
          }
          return yield* t.apply(...args);
        }),
    }))
  ).pipe(Layer.provide(folderTracker(where.tracker)));
  let reads = 0;
  const store = Layer.effect(
    Store,
    Effect.map(Store, s => ({
      ...s,
      list: (...args) =>
        Effect.suspend(() => {
          reads++;
          return s.list(...args);
        }),
    }))
  ).pipe(Layer.provide(fileStore(where.data)));
  const layer = Layer.mergeAll(tracker, store, hostSandbox(where.origin), session);
  const drives = startLoopDrives();
  const pass = (g: Graph = graph) =>
    Effect.runPromise(
      runPass(drives, fork => scanIssuesAndRunningRuns(g, 0, undefined, fork, drives.gates)).pipe(Effect.provide(layer))
    );
  let cursor = '2026-10-16T00:00:00.000Z';
  const poll = async () => {
    cursor = await Effect.runPromise(
      runPass(drives, fork => scanTrackerEvents(graph, cursor, fork, drives.gates, drives.due)).pipe(
        Effect.provide(layer)
      )
    );
    return cursor;
  };
  const read = (id: string) => Effect.runPromise(Effect.flatMap(Store, s => s.get(id)).pipe(Effect.provide(layer)));
  const status = (id: string) => read(id).then(r => r?.status);
  const ask = (kind: 'comment' | 'label' = 'comment') => {
    writeIssueAt(
      issuePath(where.tracker, 9),
      `---\ntitle: Add a farewell\nstate: open\nauthor: morgan\nlabels: [${kind === 'label' ? 'ready' : ''}]\n---\n\nAdd bye.txt.\n`
    );
    say(
      where,
      kind === 'comment'
        ? comment(9, 'morgan', true, '/agent', '2026-10-16T00:01:00.000Z')
        : { issue: 9, kind: 'label', label: 'ready', actor: 'morgan', trusted: true, at: '2026-10-16T00:01:00.000Z' }
    );
  };
  return {
    where,
    graph,
    opened,
    release,
    drives,
    pass,
    poll,
    read,
    status,
    ask,
    looked,
    cursors,
    releaseSweep,
    listings: () => listings,
    reads: () => reads,
    holding,
    withStore: <A, E>(f: (s: Store['Service']) => Effect.Effect<A, E>) =>
      Effect.runPromise(Effect.flatMap(Store, f).pipe(Effect.provide(fileStore(where.data)))),
  };
};

const locks = (data: string) =>
  existsSync(join(data, '.locks')) ? readdirSync(join(data, '.locks')).filter(f => f.endsWith('.lock')) : [];

describe('loop drives', () => {
  it.each(['comment', 'label'] as const)(
    'hears a trusted %s before a long sweep ends and handles it once',
    async kind => {
      const loop = setup(2, true);
      let finished = false;
      const sweep = loop.pass().then(runs => {
        finished = true;
        return runs;
      });
      try {
        await loop.holding;
        loop.ask(kind);
        const cursor = await loop.poll();
        await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
        const before = [...loop.looked];
        const listings = loop.listings();
        await loop.poll();
        expect([finished, loop.looked, loop.listings(), cursor]).toEqual([
          false,
          before,
          listings,
          '2026-10-16T00:01:00.000Z',
        ]);
        loop.releaseSweep();
        await sweep;
        await loop.pass();
        const second = await loop.withStore(s => s.list({ issue: 9 }));
        expect(second).toHaveLength(1);
        expect(
          readTrace(loop.where.data, second[0]!.id).filter(
            t => 'applied' in t && t.applied.proposal.kind === 'react' && !t.applied.proposal.remove
          )
        ).toHaveLength(1);
      } finally {
        loop.releaseSweep();
        loop.release();
        await sweep;
        await loop.drives.stop();
      }
    }
  );

  it('reads only since the cursor for quiet or untrusted polls, even with old ended runs', async () => {
    const loop = setup(2);
    try {
      await loop.withStore(s => s.put({ ...fresh(), started: '2020-01-01T00:00:00.000Z', status: 'done' }));
      await loop.poll();
      say(loop.where, comment(7, 'stranger', false, '/agent', '2026-10-16T00:01:00.000Z'));
      const cursor = await loop.poll();
      await loop.poll();
      expect([loop.looked, loop.listings(), loop.reads(), loop.opened, cursor, loop.cursors]).toEqual([
        [],
        0,
        0,
        [],
        '2026-10-16T00:01:00.000Z',
        ['2026-10-16T00:00:00.000Z', '2026-10-16T00:00:00.000Z', '2026-10-16T00:01:00.000Z'],
      ]);
    } finally {
      await loop.drives.stop();
    }
  });

  it('keeps reading events while a busy issue is due and ticks it once after it frees', async () => {
    const loop = setup(1, true);
    const sweep = loop.pass();
    const ticks: number[] = [];
    try {
      await loop.holding;
      const lock = loop.drives.gates.get(7)!;
      const withPermitsIfAvailable = lock.withPermitsIfAvailable.bind(lock);
      lock.withPermitsIfAvailable = permits => effect =>
        withPermitsIfAvailable(permits)(
          Effect.andThen(
            Effect.sync(() => ticks.push(7)),
            effect
          )
        );
      loop.where.human('/agent', '2026-10-16T00:01:00.000Z');
      expect(await loop.poll()).toBe('2026-10-16T00:01:00.000Z');
      expect([[...loop.drives.due.keys()], ticks]).toEqual([[7], []]);
      const counts = [loop.listings(), loop.reads()];
      await loop.poll();
      expect([loop.listings(), loop.reads()]).toEqual(counts);
      loop.ask();
      say(loop.where, comment(9, 'morgan', true, '/agent', '2026-10-16T00:02:00.000Z'));
      const before = loop.cursors.length;
      await loop.poll();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      expect([loop.cursors[before], [...loop.drives.due.keys()], ticks]).toEqual(['2026-10-16T00:01:00.000Z', [7], []]);
      loop.releaseSweep();
      await sweep;
      await loop.poll();
      await loop.poll();
      expect([[...loop.drives.due.keys()], ticks]).toEqual([[], [7]]);
    } finally {
      loop.releaseSweep();
      loop.release();
      await sweep;
      await loop.drives.stop();
    }
  });

  it('reads each landed pull request once per pass, however many issues it looks at', async () => {
    const loop = setup(4);
    const landed = [20, 21, 22, 23, 24, 25];
    try {
      for (const n of landed) {
        writeIssueAt(
          issuePath(loop.where.tracker, n),
          `---\ntitle: Landed ${n}\nstate: merged\nauthor: morgan\nlabels: []\n---\n`
        );
        write(loop.where.tracker, {
          [`${n}/pull.json`]: JSON.stringify({ branch: `agentgraph/${n - 10}`, base: 'main', head: `h${n}` }),
        });
        say(loop.where, { issue: n, kind: 'merged', actor: 'morgan', trusted: true, at: '2026-10-15T00:00:00.000Z' });
      }
      for (const n of [30, 31, 32, 33, 34, 35, 36, 37])
        writeIssueAt(
          issuePath(loop.where.tracker, n),
          `---\ntitle: Open ${n}\nstate: open\nauthor: morgan\nlabels: []\n---\n`
        );
      await loop.pass();
      const pass = loop.looked.filter(n => landed.includes(n)).length;
      expect(pass).toBe(landed.length);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('ticks the waiting run issue when its merged PR is missing from the open listing', async () => {
    const loop = setup(2);
    loop.graph.workflows.issue = {
      ...loop.graph.workflows.issue!,
      steps: [{ name: 'merge', does: { wait: 'human' }, checks: [], tries: 1 }],
    };
    const run = { ...fresh(), step: 'merge', status: 'waiting' as const };
    try {
      await loop.withStore(s => s.put(run));
      writeIssueAt(
        issuePath(loop.where.tracker, 8),
        '---\ntitle: Landed\nstate: merged\nauthor: morgan\nlabels: []\n---\n'
      );
      write(loop.where.tracker, {
        '8/pull.json': JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: 'landed' }),
      });
      say(loop.where, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at: '2026-10-16T00:01:00.000Z' });
      await loop.poll();
      expect([
        loop.looked.filter(n => n === 8).length,
        loop.drives.gates.has(7),
        (await loop.read(run.id))?.seen,
      ]).toEqual([1, true, '2026-10-16T00:01:00.000Z']);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('waits for quiet before handling a polled event and retains it for the next poll', async () => {
    const loop = setup(2);
    const now = vi.spyOn(Date, 'now').mockReturnValue(Date.parse('2026-10-16T00:01:10.000Z'));
    try {
      loop.ask();
      await loop.poll();
      expect([loop.opened.length, [...loop.drives.due.keys()]]).toEqual([0, [9]]);
      now.mockReturnValue(Date.parse('2026-10-16T00:01:31.000Z'));
      await loop.poll();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      expect([[...loop.drives.due.keys()], loop.cursors.includes('')]).toEqual([[], false]);
    } finally {
      now.mockRestore();
      loop.release();
      await loop.drives.stop();
    }
  });

  it('reads run history only after new trusted events arrive', async () => {
    const loop = setup(2);
    try {
      await loop.pass();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      const listings = loop.listings();
      const before = loop.cursors.length;
      loop.where.human('/agent', '2026-10-16T00:01:00.000Z');
      await loop.poll();
      expect([loop.listings(), loop.cursors.slice(before)]).toEqual([listings + 1, ['2026-10-16T00:00:00.000Z']]);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('answers a second issue within a pass while a long drive holds the first', async () => {
    const loop = setup(2);
    try {
      const [first] = await loop.pass();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      loop.ask();
      const [second] = await loop.pass();
      await vi.waitFor(async () => expect(await loop.status(second!.id)).toBe('waiting'), { timeout: 20_000 });
      expect([first!.issue, second!.issue, await loop.status(first!.id), loop.opened.length]).toEqual([
        7,
        9,
        'running',
        2,
      ]);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('keeps limits.parallel across passes and drives a run once', async () => {
    const loop = setup(1);
    try {
      const [first] = await loop.pass();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      loop.ask();
      const [second] = await loop.pass();
      await loop.pass();
      const during = [loop.opened.length, [...loop.drives.driving].toSorted(), await loop.status(second!.id)];
      loop.release();
      await vi.waitFor(async () => expect(await loop.status(second!.id)).toBe('waiting'), { timeout: 20_000 });
      expect([during, await loop.status(first!.id), loop.opened.length]).toEqual([
        [1, [first!.id, second!.id].toSorted(), 'running'],
        'waiting',
        2,
      ]);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('hears a stop posted during a foreground scan before applying the session reply', async () => {
    const where = world();
    const engine = services(
      where,
      [[start('foreground'), reply({ kind: 'ask', question: 'Late question' })]],
      undefined,
      () => where.human('/agent:stop', '2026-10-16T00:02:00.000Z')
    );
    const [run] = await engine.run(scanIssuesAndRunningRuns({ ...small, workflows: { issue: flow } }));
    expect(run?.status).toBe('stopped');
    expect(
      readTrace(where.data, run!.id).filter(
        t => 'applied' in t && t.applied.proposal.kind === 'comment' && t.applied.proposal.body === 'Late question'
      )
    ).toEqual([]);
  });

  it('lets a driven run hear a stop said while a pass skipped it', async () => {
    const loop = setup(2);
    try {
      const [first] = await loop.pass();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      loop.where.human('/agent:stop', '2026-10-16T00:02:00.000Z');
      await loop.pass();
      const during = await loop.status(first!.id);
      loop.release();
      await vi.waitFor(async () => expect(await loop.status(first!.id)).not.toBe('running'), { timeout: 20_000 });
      await loop.pass();
      expect([during, await loop.status(first!.id)]).toEqual(['running', 'stopped']);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('stops a queued run on a stop said while it waited for a permit, before any session', async () => {
    const loop = setup(1);
    try {
      await loop.pass();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      loop.ask();
      const [second] = await loop.pass();
      say(loop.where, comment(9, 'morgan', true, '/agent:stop', '2026-10-16T00:03:00.000Z'));
      loop.release();
      await vi.waitFor(() => expect(loop.drives.driving.size).toBe(0), { timeout: 20_000 });
      expect([await loop.status(second!.id), loop.opened.length]).toEqual(['stopped', 1]);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('leaves the end checks a later graph owes to a pass with that graph', async () => {
    const loop = setup(1);
    const later: Graph = {
      ...loop.graph,
      sha: 'g2',
      checks: {
        ...loop.graph.checks,
        present: {
          name: 'present',
          path: 'checks/present.md',
          body: '',
          mode: 'warn',
          version: 'v2',
          run: 'echo present',
        },
      },
      workflows: { issue: { ...flow, checks: ['present'] } },
    };
    try {
      await loop.pass();
      await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
      loop.ask();
      const [second] = await loop.pass();
      say(loop.where, comment(9, 'morgan', true, '/agent:stop', '2026-10-16T00:03:00.000Z'));
      await loop.pass(later);
      const owed = (await loop.read(second!.id))?.owed;
      loop.release();
      await vi.waitFor(() => expect(loop.drives.driving.size).toBe(0), { timeout: 20_000 });
      const kept = (await loop.read(second!.id))?.owed;
      await loop.pass(later);
      await vi.waitFor(() => expect(loop.drives.driving.size).toBe(0), { timeout: 20_000 });
      expect([
        owed,
        kept,
        (await loop.read(second!.id))?.owed,
        readChecks(loop.where.data, second!.id).map(e => [e.check.check, e.version]),
      ]).toEqual([['present'], ['present'], undefined, [['present', 'v2']]]);
    } finally {
      loop.release();
      await loop.drives.stop();
    }
  });

  it('interrupts its drives on stop and leaves no run lock', async () => {
    const loop = setup(2);
    const [first] = await loop.pass();
    await vi.waitFor(() => expect(loop.opened).toHaveLength(1), { timeout: 20_000 });
    const held = locks(loop.where.data);
    await loop.drives.stop();
    expect([held, locks(loop.where.data), await loop.status(first!.id), loop.drives.driving.size]).toEqual([
      [`${first!.id}.lock`],
      [],
      'running',
      0,
    ]);
  });
});
