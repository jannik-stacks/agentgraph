import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from '../src/engine.ts';
import type { Event } from '../src/event.ts';
import { loadGraph } from '../src/folder.ts';
import { fileForge } from '../src/forge.ts';
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
  const forge = join(root, 'forge');
  mkdirSync(forge);
  git(root, 'clone', '-q', '--bare', seed, join(forge, 'origin.git'));
  writeFileSync(
    join(forge, '1.md'),
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
  appendFileSync(join(forge, '1.jsonl'), `${JSON.stringify(label)}\n`);
  return { origin: join(forge, 'origin.git'), forge, data };
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
    Layer.mergeAll(fileForge(where.forge), fileStore(where.data), hostSandbox(where.origin), replaySession(sessions));
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
