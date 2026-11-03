import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from '../src/engine.ts';
import type { Event } from '../src/event.ts';
import { loadGraph } from '../src/folder.ts';
import { folderTracker } from '../src/tracker.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, seeded, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';

const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'retro-gate'), harnesses));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const world = () => {
  const { root, seed, data } = seeded('retro-gate', { 'README.md': 'demo\n' });
  dirs.push(root);
  const tracker = join(root, 'tracker');
  mkdirSync(tracker);
  git(root, 'clone', '-q', '--bare', seed, join(tracker, 'origin.git'));
  writeFileSync(
    join(tracker, '1.md'),
    '---\ntitle: Issue 1\nstate: open\nauthor: morgan\nlabels: []\n---\n\nSay hello.\n'
  );
  const label: Event = {
    issue: 1,
    kind: 'label',
    label: 'agent:ready',
    actor: 'morgan',
    trusted: true,
    at: '2026-10-16T00:00:01.000Z',
  };
  appendFileSync(join(tracker, '1.jsonl'), `${JSON.stringify(label)}\n`);
  return { origin: join(tracker, 'origin.git'), tracker, data };
};

const failedCall = (i: number): SessionEvent => ({
  type: 'tool',
  id: `t${i}`,
  name: 'bash',
  input: { command: 'pnpm test' },
  output: 'pnpm: not found',
  ok: false,
});

const implement = (failed: number): SessionEvent[] => [
  start('i1'),
  ...Array.from({ length: failed }, (_, i) => failedCall(i)),
  wrote('hello.txt', 'hello\n'),
  reply(
    { kind: 'push', branch: 'agentgraph/1', message: 'say hello' },
    { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Say hello', body: 'Closes #1' }
  ),
];

const ticks = async (where: ReturnType<typeof world>, ...turns: SessionEvent[][][]) => {
  const layer = (sessions: SessionEvent[][]) =>
    Layer.mergeAll(
      folderTracker(where.tracker),
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession(sessions)
    );
  for (const sessions of turns) await Effect.runPromise(tick(graph).pipe(Effect.provide(layer(sessions))));
  return Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(where.data))));
};

describe('the retro gate example', () => {
  it('starts a retro after more than five failed tool calls, then moves on to merge', async () => {
    const where = world();
    const retro = [start('r1'), reply({ kind: 'comment', body: 'Add pnpm to the setup.' })];
    const [gated] = await ticks(where, [implement(6)]);
    expect(gated).toMatchObject({
      step: 'gate',
      status: 'waiting',
      reason: expect.stringMatching(/^waiting on retro-1-/),
    });
    const runs = await ticks(where, [retro], []);
    expect(runs.map(r => [r.workflow, r.step, r.status]).toSorted()).toEqual([
      ['issue', 'merge', 'waiting'],
      ['retro', 'retro', 'done'],
    ]);
    expect(runs.find(r => r.workflow === 'retro')!.by).toBe(runs.find(r => r.workflow === 'issue')!.id);
  });

  it('goes straight to merge with five failed tool calls or fewer', async () => {
    const where = world();
    const runs = await ticks(where, [implement(5)]);
    expect(runs.map(r => [r.workflow, r.step, r.status])).toEqual([['issue', 'merge', 'waiting']]);
  });
});

describe('a run step', () => {
  const issue = graph.workflows.issue!;
  const gated = (seen: string, reads?: 'traces') => ({
    ...graph,
    workflows: {
      ...graph.workflows,
      issue: {
        ...issue,
        steps: issue.steps.map(s =>
          s.name === 'gate'
            ? {
                ...s,
                does: {
                  run: `env | grep -o '^AGENTGRAPH_[A-Z_]*' | sort > ${seen}; if [ -n "$AGENTGRAPH_RUN_TRACE" ]; then grep -q pnpm "$AGENTGRAPH_RUN_TRACE" && grep -q pnpm "$AGENTGRAPH_TRACES" && echo populated >> ${seen}; fi; true`,
                  ...(reads && { reads }),
                },
              }
            : s
        ),
      },
    },
  });
  const gate = async (reads?: 'traces') => {
    const where = world();
    const seen = join(dirname(where.tracker), 'seen');
    const checksRead: string[] = [];
    const store = Layer.effect(
      Store,
      Effect.map(Store, s => ({
        ...s,
        readChecks: (id: string) => Effect.suspend(() => (checksRead.push(id), s.readChecks(id))),
      }))
    ).pipe(Layer.provide(fileStore(where.data)));
    const layer = Layer.mergeAll(
      folderTracker(where.tracker),
      store,
      hostSandbox(where.origin),
      replaySession([implement(1)])
    );
    await Effect.runPromise(tick(gated(seen, reads)).pipe(Effect.provide(layer)));
    return { seen: readFileSync(seen, 'utf8').split('\n').filter(Boolean), checksRead: checksRead.length };
  };

  it('gets the trace files only with reads: traces, and prepares no traces without it', async () => {
    const plain = await gate();
    const reading = await gate('traces');
    expect(plain.seen).toContain('AGENTGRAPH_ISSUE');
    expect(plain.seen).not.toContain('AGENTGRAPH_TRACES');
    expect(plain.seen).not.toContain('AGENTGRAPH_RUN_TRACE');
    expect(reading.seen).toEqual(expect.arrayContaining(['AGENTGRAPH_TRACES', 'AGENTGRAPH_RUN_TRACE', 'populated']));
    expect(reading.checksRead - plain.checksRead).toBe(1);
  });
});
