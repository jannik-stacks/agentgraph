import { appendFileSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Deferred, Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { folderTracker, Tracker, TrackerError } from '../src/tracker.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox, type Command } from '../src/sandbox.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { begin, transition, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, start, wrote } from './fixtures.ts';
import { git, issuePath } from './kit.ts';
import {
  world,
  push,
  pull,
  services,
  readTrace,
  bodies,
  driveStored,
  fresh,
  pullRequest,
  say,
  comment,
} from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';

const refuse = (p: Proposal) => Effect.succeed({ proposal: p, ok: false, reason: 'branch moved' });

describe('a run branch that moved', () => {
  const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
  const flow = {
    ...small.workflows.issue!,
    steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: ['types'] })),
  };

  it('journals accepted proposals before a later failure and does not post them twice', async () => {
    const where = world();
    const kit = {
      ...small,
      agents: {
        ...small.agents,
        implementor: { ...small.agents.implementor!, returns: [...small.agents.implementor!.returns, 'tell' as const] },
      },
    };
    let fail = true;
    const failing = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          if (p.kind === 'comment' && p.body === 'Second' && fail) {
            fail = false;
            return Effect.fail(new TrackerError({ message: 'connection failed' }));
          }
          return f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const proposals: Proposal[] = [
      { kind: 'tell', issue: 8, text: 'Remember this' },
      push,
      pull,
      { kind: 'comment', body: 'First' },
      { kind: 'comment', body: 'Second' },
    ];
    const layer = Layer.mergeAll(
      failing,
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession([
        [start('a'), wrote('hello.txt', 'hello\n'), reply(...proposals)],
        [start('a'), reply(...proposals)],
      ])
    );
    const [done, issue] = await Effect.runPromise(
      Effect.gen(function* () {
        yield* Effect.flatMap(Store, store =>
          store.put({
            ...begin(flow, { id: 'target-8', issue: 8, started: fresh().started }),
            status: 'waiting',
            reason: 'Waiting',
          })
        );
        const parked = yield* runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), kit);
        expect(
          readTrace(where.data, 'run-7').some(
            t =>
              'applied' in t &&
              t.applied.ok &&
              t.applied.proposal.kind === 'comment' &&
              t.applied.proposal.body === 'First'
          )
        ).toBe(true);
        const done = yield* driveStored(flow, transition(flow, parked, { kind: 'answer', text: 'Retry' }), kit);
        return [done, yield* Effect.flatMap(Tracker, f => f.issue(7))] as const;
      }).pipe(Effect.provide(layer))
    );
    expect(done.status).toBe('done');
    expect(readTrace(where.data, 'target-8').filter(t => 'told' in t)).toHaveLength(1);
    expect(bodies(issue).filter(body => body.split('\n\n')[0] === 'First')).toHaveLength(1);
    const applied = readTrace(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.ok ? [t.applied.proposal] : []
    );
    expect(applied.filter(p => p.kind === 'comment' && p.body === 'Second')).toHaveLength(1);
    expect(applied.filter(p => p.kind === 'push')).toHaveLength(1);
  });

  it('posts a repeated runner question after a new human answer', async () => {
    const where = world();
    const { run } = services(where, [
      [start('a'), reply({ kind: 'ask', question: 'Which?' })],
      [start('a'), reply({ kind: 'ask', question: 'Which?' })],
    ]);
    const issue = await run(
      Effect.gen(function* () {
        const asked = yield* runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        yield* driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'This one' }), small);
        return yield* Effect.flatMap(Tracker, f => f.issue(7));
      })
    );
    expect(bodies(issue).filter(body => /^@\S+ Which\?\n/.test(body))).toHaveLength(2);
  });

  it('reuses a created child after a later child proposal fails', async () => {
    const where = world();
    let fail = true;
    const failing = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          if (p.kind === 'issue' && p.title === 'Second part' && fail) {
            fail = false;
            return Effect.fail(new TrackerError({ message: 'connection failed' }));
          }
          return f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const proposals = ['First part', 'Second part'].map(title => ({
      kind: 'issue',
      title,
      body: '## Done when\nComplete',
      relation: 'part',
      size: 'S',
    }));
    const end: SessionEvent = {
      type: 'end',
      ended: 'stop',
      exit: 0,
      final: '```agentgraph\n' + JSON.stringify(proposals) + '\n```',
    };
    const layer = Layer.mergeAll(
      failing,
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession([
        [start('a'), end],
        [start('a'), end],
      ])
    );
    const [done, issues] = await Effect.runPromise(
      Effect.gen(function* () {
        const parked = yield* runWorkflow(
          flow,
          begin(flow, { id: 'run-7', issue: 7, started: fresh().started }),
          small
        );
        const done = yield* driveStored(flow, transition(flow, parked, { kind: 'answer', text: 'Retry' }), small);
        return [done, yield* Effect.flatMap(Tracker, f => f.issues())] as const;
      }).pipe(Effect.provide(layer))
    );
    expect(done.status).toBe('done');
    expect(issues.filter(t => t.parent === 7).map(t => t.title)).toEqual(['First part', 'Second part']);
  });

  it('persists identical output from concurrent checks without a temp-file collision', async () => {
    const where = world();
    const names = ['types', 'one', 'two', 'three'];
    const checks = Object.fromEntries(
      names.map(name => [name, { ...small.checks.types!, name, run: 'printf identical-output' }])
    );
    const checked = { ...flow, steps: flow.steps.map(step => ({ ...step, checks: names })) };
    const kit = { ...small, checks, workflows: { issue: checked } };
    const sandbox = Layer.effect(
      Sandbox,
      Effect.gen(function* () {
        const s = yield* Sandbox;
        const ready = yield* Deferred.make<void>();
        let completed = 0;
        return {
          ...s,
          exec: (command: Command) =>
            s.exec(command).pipe(
              Effect.tap(() =>
                Effect.gen(function* () {
                  if (++completed === names.length) yield* Deferred.succeed(ready, undefined);
                  yield* Deferred.await(ready);
                })
              )
            ),
        };
      })
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    const layer = Layer.mergeAll(
      folderTracker(where.tracker),
      fileStore(where.data),
      sandbox,
      replaySession([[start('a'), wrote('hello.txt', 'hi'), reply(push, pull)]])
    );
    const done = await Effect.runPromise(
      runWorkflow(checked, begin(checked, { id: 'run-7', issue: 7, started: fresh().started }), kit).pipe(
        Effect.provide(layer)
      )
    );
    expect(done.status).toBe('done');
    const logs = readdirSync(join(where.data, 'logs')).filter(name => name.endsWith('.gz'));
    expect(logs).toHaveLength(1);
    const output = await Effect.runPromise(
      Effect.flatMap(Store, s => s.readLog(logs[0]!.slice(0, -3))).pipe(Effect.provide(fileStore(where.data)))
    );
    expect(output).toBe('identical-output');
  });

  it.each([false, true])('recovers an unterminated last trace record (partial: %s)', async partial => {
    const where = world();
    const current = begin(flow, { id: 'run-7', issue: 7, started: fresh().started });
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(current)).pipe(Effect.provide(fileStore(where.data))));
    const path = join(where.data, 'run-7', 'trace.jsonl');
    const good = readFileSync(path, 'utf8');
    const fragment = '{"at":"unfinished';
    writeFileSync(path, partial ? good + fragment : good.trimEnd());
    const { run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)]]);
    const done = await run(runWorkflow(flow, current, small));
    expect(done.status).toBe('done');
    expect(readTrace(where.data, 'run-7').some(t => 'outcome' in t)).toBe(true);
    const fragments = readdirSync(join(where.data, 'run-7')).filter(name => name.endsWith('.partial'));
    expect(fragments).toHaveLength(partial ? 1 : 0);
    if (partial) expect(readFileSync(join(where.data, 'run-7', fragments[0]!), 'utf8')).toBe(fragment);
    expect(readFileSync(path, 'utf8')).toContain(good.trimEnd());
  });

  it('reads an interrupted trace before tick records a new answer', async () => {
    const where = world();
    const current = {
      ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }),
      status: 'waiting' as const,
      reason: 'Which?',
    };
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(current)).pipe(Effect.provide(fileStore(where.data))));
    appendFileSync(join(where.data, 'run-7', 'trace.jsonl'), '{"at":"unfinished');
    where.human('/agent this one', '2026-10-16T00:00:05.000Z');
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Follow up?' })]]);
    await run(tick(small, 7));
    expect(await run(Effect.flatMap(Store, s => s.get('run-7')))).toMatchObject({
      status: 'waiting',
      reason: 'Follow up?',
    });
  });

  it('continues to reject a complete corrupt trace record', async () => {
    const where = world();
    const current = begin(flow, { id: 'run-7', issue: 7, started: fresh().started });
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(current)).pipe(Effect.provide(fileStore(where.data))));
    appendFileSync(join(where.data, 'run-7', 'trace.jsonl'), 'broken record\n');
    const { run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)]]);
    await expect(run(runWorkflow(flow, current, small))).rejects.toThrow(
      `${join(where.data, 'run-7', 'trace.jsonl')}: Unexpected token 'b', "broken record" is not valid JSON`
    );
  });

  it('keeps the human answer in a fresh session after a failed try', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [wrote('hello.txt', 'TODO\n'), reply(push, pull)],
      [wrote('hello.txt', 'hello\n'), reply(push, pull)],
    ]);
    const current = {
      ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }),
      feedback: 'Use blue',
      answers: [{ asked: 'Which color?', said: 'Use blue' }],
    };
    const done = await run(runWorkflow(flow, current, small));
    expect(done.status).toBe('done');
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume).toBeUndefined();
    expect(specs[1]!.prompt).toContain('Use blue');
    expect(specs[1]!.prompt).toContain('types');
  });

  it.each([false, true])(
    'returns held files to the proposing agent before posting replies (held only: %s)',
    async only => {
      const where = world();
      const { specs, run } = services(where, [
        [
          start('a'),
          ...(only ? [] : [wrote('hello.txt', 'hello\n')]),
          wrote('.github/workflows/socket.yml', 'on: push\n'),
          reply(push, { kind: 'comment', body: 'Added .github/workflows/socket.yml' }, pull),
        ],
        [start('a'), reply({ kind: 'ask', question: 'Please have a maintainer push the workflow.' })],
      ]);
      const done = await run(
        runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
      );
      expect(done.status).toBe('waiting');
      expect(specs[1]!.prompt).toContain('.github/workflows/socket.yml');
      expect(specs[1]!.prompt).toContain(only ? 'Nothing pushed' : 'Not pushed');
      expect(readFileSync(issuePath(where.tracker, 7, 'events.jsonl'), 'utf8')).not.toContain(
        'Added .github/workflows/socket.yml'
      );
      const applied = readTrace(where.data, 'run-7').flatMap(t =>
        'applied' in t && t.applied.proposal.kind === 'push' ? [t.applied] : []
      );
      expect(applied[0]).toMatchObject({ ok: false, held: ['.github/workflows/socket.yml'] });
      expect(Boolean(applied[0]!.url)).toBe(!only);
    }
  );

  it('finishes after reporting a held file once without retrying the next push', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [
        start('a'),
        wrote('hello.txt', 'hello\n'),
        wrote('.github/workflows/socket.yml', 'on: push\n'),
        reply(push, pull),
      ],
      [start('a'), wrote('other.txt', 'other\n'), reply(push, pull)],
    ]);
    const done = await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    const applied = readTrace(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'push' ? [t.applied] : []
    );
    expect(done.status).toBe('done');
    expect(specs).toHaveLength(2);
    expect(applied.map(p => ({ ok: p.ok, held: p.held }))).toEqual([
      { ok: false, held: ['.github/workflows/socket.yml'] },
      { ok: true, held: ['.github/workflows/socket.yml'] },
    ]);
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('other');
  });

  const unpushed = 'The push with this reply failed, so its changes are not on the pull request yet.';

  const failingPush = (
    pushed: (p: Proposal, real: ReturnType<Tracker['Service']['apply']>) => ReturnType<Tracker['Service']['apply']>,
    turns: SessionEvent[][]
  ) => {
    const where = world();
    pullRequest(where);
    const review = comment(8, 'morgan', true, '/agent question only what is sfw?', '2026-10-16T00:00:03.000Z');
    say(where, { ...review, comment: { ...review.comment!, id: 'r1', path: 'hello.txt', line: 1 } });
    const attempted: Proposal[] = [];
    const failing = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          attempted.push(p);
          return p.kind === 'push' ? pushed(p, f.apply(n, p, work)) : f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const layer = Layer.mergeAll(failing, fileStore(where.data), hostSandbox(where.origin), replaySession(turns));
    const drive = (said?: Run['said']) =>
      Effect.runPromise(
        runWorkflow(
          flow,
          { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), ...(said && { said }) },
          small
        ).pipe(Effect.provide(layer))
      );
    const replies = async () =>
      (await Effect.runPromise(Effect.flatMap(Tracker, f => f.issue(8)).pipe(Effect.provide(layer)))).events
        .flatMap(m => m.comment ?? [])
        .filter(c => c.author === 'agentgraph[bot]')
        .map(c => [c.body, c.under]);
    return { where, attempted, drive, replies };
  };

  it('returns a refused push to the agent, posting only its thread replies with a note', async () => {
    const answers = [
      { kind: 'comment', body: 'Socket Firewall.', under: 'r1' },
      { kind: 'comment', body: 'Fixed; the validation now rejects empty input.', under: 'r1' },
    ] satisfies Proposal[];
    const skipped: Proposal[] = [
      { kind: 'comment', body: 'Changes landed' },
      { kind: 'label', add: ['done'] },
      { kind: 'issue', title: 'Follow up', body: '## Done when\nDetails', relation: 'follow-up' } as Proposal,
    ];
    const { where, attempted, drive, replies } = failingPush(refuse, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply(...answers, ...skipped, push, pull)],
      [start('a'), reply({ kind: 'ask', question: 'Retry later' })],
    ]);
    const done = await drive();
    expect(done).toMatchObject({ status: 'waiting', reason: 'Retry later' });
    expect(attempted.some(p => skipped.some(s => JSON.stringify(s) === JSON.stringify(p)))).toBe(false);
    const failed = readTrace(where.data, 'run-7').flatMap(t =>
      'outcome' in t && t.outcome.kind === 'failed' ? [t.outcome] : []
    );
    expect(failed[0]!.proposals.map(a => a.proposal)).toEqual([push, ...skipped.slice(0, 2), pull, skipped[2]]);
    expect(readFileSync(issuePath(where.tracker, 7, 'events.jsonl'), 'utf8')).not.toContain('Changes landed');
    expect(await replies()).toEqual([
      ...answers.map(a => [`${a.body}\n\n${unpushed}`, 'r1']),
      [expect.stringMatching(/^@morgan Retry later\n/), undefined],
    ]);
  });

  it('notes a refused push under a reply routed to the thread that woke the run', async () => {
    const { drive, replies } = failingPush(refuse, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'Fixed.' }, push, pull)],
      [start('a'), reply({ kind: 'ask', question: 'Retry later' })],
    ]);
    await drive([{ issue: 8, under: 'r1' }]);
    expect(await replies()).toEqual([
      [`Fixed.\n\n${unpushed}`, 'r1'],
      [expect.stringMatching(/^@morgan Retry later\n/), undefined],
    ]);
  });

  it.each([
    { throws: 2, status: 'waiting' },
    { throws: 1, status: 'done' },
  ])('posts the thread reply once when the push throws $throws times', async ({ throws, status }) => {
    const answer = { kind: 'comment', body: 'Socket Firewall.', under: 'r1' } satisfies Proposal;
    let pushes = 0;
    const { drive, replies } = failingPush(
      (_p, real) =>
        ++pushes <= throws ? Effect.fail(new TrackerError({ status: 502, message: 'bad gateway' })) : real,
      [
        [start('a'), wrote('hello.txt', 'hello\n'), reply(answer, push, pull)],
        [start('a'), reply(answer, push, pull)],
      ]
    );
    const ended = await drive();
    expect(ended.status).toBe(status);
    expect(ended.reason?.startsWith('Stopped by a runner error') ?? false).toBe(status === 'waiting');
    expect(await replies()).toEqual([
      [`Socket Firewall.\n\n${unpushed}`, 'r1'],
      ...(status === 'done' ? [] : [[expect.stringMatching(/^@morgan Paused on an agentgraph problem/), undefined]]),
    ]);
  });
});
