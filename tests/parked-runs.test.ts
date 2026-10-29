import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { stoppedByRunner } from '../src/context.ts';
import { drive, instruct } from '../src/engine.ts';
import { Store } from '../src/store.ts';
import { begin, type Run } from '../src/workflow.ts';
import { makeTestGraph, reply, start } from './fixtures.ts';
import { services, world } from './world.ts';

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
  reason: `${stoppedByRunner} (SessionStop). Reply to try implement again from where it was.`,
  retried: true,
  feedback: 'Keep the original feedback.',
});

describe('resume', () => {
  it.each(['id', 'parked'] as const)(
    'queues a parked retro by %s and completes it without posting',
    async selection => {
      const where = world();
      const before = readFileSync(join(where.forge, '7.jsonl'), 'utf8');
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
      expect((await run(drive(flow, resumed[0]!, graph))).status).toBe('done');
      expect(specs).toHaveLength(1);
      expect(specs[0]!.resume).toEqual(original.sessions.implement);
      expect(marks).toEqual([]);
      expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).toBe(before);
    }
  );

  it('selects only runner errors when resuming all parked runs', async () => {
    const { run } = services(world(), []);
    const { retried: _retried, ...notRetried } = parked('not-retried');
    const runs: Run[] = [
      parked('retro-1'),
      { ...parked('retro-2'), reason: `${stoppedByRunner} (SandboxError). Reply to try again.` },
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
        return yield* Effect.either(instruct(graph, { kind: 'resume', id: before.id }));
      }).pipe(Effect.scoped)
    );
    expect(result).toMatchObject({ _tag: 'Left', left: { _tag: 'StoreError' } });
    expect(await run(Effect.flatMap(Store, store => store.get(before.id)))).toEqual(before);
  });

  it.each([
    ['missing', 'no run absent'],
    ['question', 'run question is not parked by a runner error'],
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
