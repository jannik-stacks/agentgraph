import { existsSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { runPass, scanIssuesAndRunningRuns, startLoopDrives } from '../src/run/trigger.ts';
import { folderTracker } from '../src/tracker.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionSpec } from '../src/trace.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, start } from './fixtures.ts';
import { issuePath, writeIssueAt } from './kit.ts';
import type { Graph } from '../src/folder.ts';
import { comment, readChecks, say, world } from './world.ts';

const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
const flow = {
  ...small.workflows.issue!,
  checks: [],
  steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: [] })),
};
const asks = [start('s'), reply({ kind: 'ask', question: 'Continue?' })];

const setup = (parallel: number) => {
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
  const layer = Layer.mergeAll(folderTracker(where.tracker), fileStore(where.data), hostSandbox(where.origin), session);
  const drives = startLoopDrives();
  const pass = (g: Graph = graph) =>
    Effect.runPromise(
      runPass(drives, fork => scanIssuesAndRunningRuns(g, 0, undefined, fork)).pipe(Effect.provide(layer))
    );
  const read = (id: string) => Effect.runPromise(Effect.flatMap(Store, s => s.get(id)).pipe(Effect.provide(layer)));
  const status = (id: string) => read(id).then(r => r?.status);
  const ask = () => {
    writeIssueAt(
      issuePath(where.tracker, 9),
      '---\ntitle: Add a farewell\nstate: open\nauthor: morgan\nlabels: []\n---\n\nAdd bye.txt.\n'
    );
    say(where, comment(9, 'morgan', true, '/agent', '2026-10-16T00:01:00.000Z'));
  };
  return { where, graph, opened, release, drives, pass, read, status, ask };
};

const locks = (data: string) =>
  existsSync(join(data, '.locks')) ? readdirSync(join(data, '.locks')).filter(f => f.endsWith('.lock')) : [];

describe('loop drives', () => {
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
