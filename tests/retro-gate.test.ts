import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import type { Event } from '../src/event.ts';
import { loadGraph } from '../src/folder.ts';
import { folderTracker } from '../src/tracker.ts';
import { fileStore, Store } from '../src/store.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, seeded, start, wrote } from './fixtures.ts';
import { appendIssueAt, issuePath, writeIssueAt } from './kit.ts';
import { formatReason, type Agent, type SessionEvent } from '../src/types.ts';

const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'retro-gate'), harnesses));

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const world = () => {
  const { root, data } = seeded('retro-gate', { 'README.md': 'demo\n' }, 'tracker/origin.git');
  dirs.push(root);
  const tracker = join(root, 'tracker');
  writeIssueAt(
    issuePath(tracker, 1),
    '---\ntitle: Issue 1\nstate: open\nauthor: morgan\nlabels: []\n---\n\nSay hello.\n'
  );
  const label: Event = {
    id: 'label-1',
    issue: 1,
    kind: 'label',
    label: 'agent:ready',
    actor: 'morgan',
    bot: false,
    trusted: true,
    at: '2026-10-16T00:00:01.000Z',
  };
  appendIssueAt(issuePath(tracker, 1, 'events.jsonl'), `${JSON.stringify(label)}\n`);
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

const ticks = async (where: ReturnType<typeof world>, turns: SessionEvent[][][], g = graph) => {
  const layer = (sessions: SessionEvent[][]) =>
    Layer.mergeAll(
      folderTracker(where.tracker),
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession(sessions)
    );
  for (const sessions of turns) await Effect.runPromise(tick(g).pipe(Effect.provide(layer(sessions))));
  return Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(where.data))));
};

describe('the retro gate example', () => {
  it('starts a retro after more than five failed tool calls, then moves on to merge', async () => {
    const where = world();
    const retro = [start('r1'), reply({ kind: 'comment', body: 'Add pnpm to the setup.' })];
    const [gated] = await ticks(where, [[implement(6)]]);
    expect(gated).toMatchObject({
      step: 'gate',
      status: 'waiting',
      waiting: { on: 'run', id: expect.stringMatching(/^retro-1-/) },
    });
    const runs = await ticks(where, [[retro], []]);
    expect(runs.map(r => [r.workflow, r.step, r.status]).toSorted()).toEqual([
      ['issue', 'merge', 'waiting'],
      ['retro', 'retro', 'done'],
    ]);
    expect(runs.find(r => r.workflow === 'retro')!.by).toBe(runs.find(r => r.workflow === 'issue')!.id);
  });

  it('goes straight to merge with five failed tool calls or fewer', async () => {
    const where = world();
    const runs = await ticks(where, [[implement(5)]]);
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
                  returns: ['run' as const],
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

describe('a script step', () => {
  const head = `'"$(git ls-remote origin refs/heads/agentgraph/1 | cut -f1)"'`;
  const secret = 'checkout secret 42';
  const printing = (proposal: object, returns: Agent['returns'] = ['run']) => {
    const issue = graph.workflows.issue!;
    const run = `printf '%s\\n' '\`\`\`agentgraph' '${JSON.stringify([proposal]).replace('HEAD', head)}' '\`\`\`'`;
    const back = { to: 'implement', until: 'the gate passes', rounds: 1 };
    const steps = issue.steps.map(s => (s.name === 'gate' ? { ...s, does: { run, returns }, back } : s));
    return { ...graph, workflows: { ...graph.workflows, issue: { ...issue, steps } } };
  };
  const proposals = {
    merge: { kind: 'merge', number: 2, head: 'HEAD' },
    push: { kind: 'push', branch: 'agentgraph/1', message: 'again' },
    pull_request: { kind: 'pull_request', branch: 'agentgraph/1', base: 'main', title: 'Hello', body: 'Closes #1' },
    ask: { kind: 'ask', question: secret },
    back: { kind: 'back', why: secret },
  } as const;
  const kinds = Object.keys(proposals) as (keyof typeof proposals)[];
  const trackerText = (where: ReturnType<typeof world>) =>
    readdirSync(where.tracker, { recursive: true, withFileTypes: true })
      .filter(f => f.isFile() && !f.parentPath.includes('origin.git'))
      .map(f => readFileSync(join(f.parentPath, f.name), 'utf8'))
      .join('\n');

  it.each(kinds.flatMap(kind => [[kind, undefined] as const, [kind, [] as Agent['returns']] as const]))(
    'may not propose %s with returns %j',
    async (kind, returns) => {
      const where = world();
      const [run] = await ticks(where, [[implement(0)]], printing(proposals[kind], returns));
      expect([run!.step, run!.status, run!.reason, trackerText(where).includes(secret)]).toEqual([
        'gate',
        'waiting',
        expect.stringContaining(`gate may not propose ${kind}`),
        false,
      ]);
    }
  );

  const granted = {
    merge: ['merge', 'waiting', undefined],
    push: ['merge', 'waiting', undefined],
    pull_request: ['merge', 'waiting', undefined],
    ask: ['gate', 'waiting', secret],
    back: ['implement', 'waiting', expect.any(String)],
  };

  it.each(kinds)('proposes %s when its returns list it', async kind => {
    const [run] = await ticks(world(), [[implement(0)]], printing(proposals[kind], [kind]));
    expect([run!.step, run!.status, formatReason(run!)]).toEqual(granted[kind]);
  });
});
