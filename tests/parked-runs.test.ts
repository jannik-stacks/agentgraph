import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { stoppedByEngine } from '../src/context.ts';
import { instruct, tick } from '../src/run/trigger.ts';
import { Tracker } from '../src/tracker.ts';
import { isOnIssue } from '../src/graph.ts';
import { findRunsWaitingOnPeople, formatNextSteps } from '../src/status.ts';
import { Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { makeTestGraph, reply, start } from './fixtures.ts';
import { bodies, services, settleLongAgo, world } from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';
import { findStatus, issuePath } from './kit.ts';
import { type Run } from '../src/types.ts';

const small = makeTestGraph('graph');
const { branch: _branch, ...unbranched } = small.workflows.issue!;
const flow = {
  ...unbranched,
  name: 'retro',
  on: { feedback: {} },
  steps: unbranched.steps.map(s => ({ ...s, checks: [] })),
};
const graph = { ...small, workflows: { retro: flow } };
const parked = (id: string): Run => ({
  ...begin(flow, { id, issue: 7, started: '2026-10-16T00:00:01.000Z' }),
  status: 'waiting',
  reason: `${stoppedByEngine} (SessionStop). Reply to try implement again from where it was.`,
  retried: true,
  feedback: 'Keep the original feedback.',
});

describe('resume', () => {
  it.each(['id', 'parked'] as const)(
    'clears a parked retro without a word on the issue by %s',
    async selection => {
      const where = world();
      const { run, marks, specs } = services(where, [[start('r'), reply()]]);
      const original = {
        ...parked('retro-7'),
        sessions: { implement: { id: 'kept-session', home: join(where.root, 'home') } },
      };
      await run(Effect.flatMap(Store, store => store.put(original)));
      const resumed = await run(
        instruct(graph, selection === 'id' ? { kind: 'resume', id: 'retro-7' } : { kind: 'resume', parked: true })
      );
      expect(resumed).toHaveLength(1);
      expect(resumed[0]).toMatchObject({ id: 'retro-7', status: 'running', feedback: 'Keep the original feedback.' });
      expect(resumed[0]!.reason).toBeUndefined();
      expect(resumed[0]!.retried).toBeUndefined();
      const back = resumed.filter(isOnIssue)[0]!;
      expect((await run(runWorkflow(flow, back, graph))).status).toBe('done');
      expect(specs).toHaveLength(1);
      expect(specs[0]!.resume).toEqual(original.sessions.implement);
      expect(marks).toEqual([]);
      expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))))).toEqual(['/agent']);
      expect(readFileSync(issuePath(where.tracker, 7), 'utf8')).toContain('labels: []');
    },
    60_000
  );

  it.each(['cli', 'reply'] as const)(
    'keeps a retro problem off the issue and clears it by %s',
    async via => {
      const where = world();
      const { run } = services(where, []);
      const parentFlow = { ...flow, name: 'issue', on: { issue_comment: {} } };
      const combined = { ...graph, workflows: { ...graph.workflows, issue: parentFlow } };
      await services(where, [[start('i'), reply()]]).run(
        runWorkflow(
          parentFlow,
          begin(parentFlow, { id: 'issue-7', issue: 7, started: '2026-10-16T00:00:00.000Z' }),
          combined
        )
      );
      await run(settleLongAgo('issue-7'));
      const { reason: _reason, ...working } = parked('retro-7');
      const paused = await run(runWorkflow(flow, { ...working, status: 'running' }, combined));
      expect(paused.reason).toContain(stoppedByEngine);
      expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))))).toEqual(['/agent']);
      expect(findStatus(where.tracker, 7)).toBe('done');
      const next = services(where, [[start('r'), reply()]]);
      if (via === 'cli') await next.run(instruct(combined, { kind: 'resume', parked: true }));
      else {
        where.human('/agent retry', new Date(Date.now() + 1).toISOString());
        await next.run(tick(combined, 7));
      }
      const after = await next.run(Effect.flatMap(Tracker, f => f.issue(7)));
      expect(bodies(after)).toEqual(['/agent', ...(via === 'reply' ? ['/agent retry'] : [])]);
      expect(findStatus(where.tracker, 7)).toBe('done');
      expect(
        findRunsWaitingOnPeople([paused])
          .flatMap(r => formatNextSteps(r))
          .join('\n')
      ).toContain('retro-7 retro #7 is waiting: Stopped by an engine error.');
    },
    60_000
  );

  it('selects only engine errors when resuming all parked runs', async () => {
    const { run } = services(world(), []);
    const { retried: _retried, ...notRetried } = parked('not-retried');
    const runs: Run[] = [
      parked('retro-1'),
      { ...parked('retro-2'), reason: `${stoppedByEngine} (SandboxError). Reply to try again.` },
      { ...parked('question'), reason: 'Which version?' },
      { ...parked('cancelled'), reason: 'Cancelled by a person.' },
      { ...parked('done'), status: 'done' },
      { ...parked('running'), status: 'running' },
      notRetried,
    ];
    await run(Effect.flatMap(Store, store => Effect.forEach(runs, r => store.put(r))));
    expect((await run(instruct(graph, { kind: 'resume', parked: true }))).map(r => r.id)).toEqual([
      'retro-1',
      'retro-2',
    ]);
    expect(await run(instruct(graph, { kind: 'resume', parked: true }))).toEqual([]);
  });

  it('leaves a locked run to its current driver', async () => {
    const { run } = services(world(), []);
    const before = parked('retro-7');
    await run(Effect.flatMap(Store, store => store.put(before)));
    const result = await run(
      Effect.gen(function* () {
        const store = yield* Store;
        yield* store.lock(before.id);
        return yield* Effect.result(instruct(graph, { kind: 'resume', id: before.id }));
      }).pipe(Effect.scoped)
    );
    expect(result).toMatchObject({ _tag: 'Failure', failure: { _tag: 'StoreError' } });
    expect(await run(Effect.flatMap(Store, store => store.get(before.id)))).toEqual(before);
  });

  it.each([
    ['missing', 'no run absent'],
    ['question', 'run question is not parked by an engine error'],
    ['unknown-step', 'the graph has no step retro/gone'],
  ])('rejects %s without changing the run', async (id, message) => {
    const { run } = services(world(), []);
    const before = id === 'question' ? { ...parked(id), reason: 'Which version?' } : { ...parked(id), step: 'gone' };
    await run(Effect.flatMap(Store, store => store.put(before)));
    await expect(run(instruct(graph, { kind: 'resume', id: id === 'missing' ? 'absent' : id }))).rejects.toThrow(
      message
    );
    expect(await run(Effect.flatMap(Store, store => store.get(id)))).toEqual(before);
  });
});
