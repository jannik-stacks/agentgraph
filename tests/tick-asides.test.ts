import { readdirSync, readFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { instruct, tick } from '../src/run/trigger.ts';
import { folderTracker, Tracker } from '../src/tracker.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox, SandboxError } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { reply, start, wrote } from './fixtures.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';
import { world, push, pull, services, readTrace, reactions, bodies, fresh, say, comment } from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';

import { small, merging, waiting } from './tick-fixtures.ts';
import { type Agent, type SessionEvent, type SessionSpec, TrackerError } from '../src/types.ts';

describe('tick', () => {
  it('takes an approval that came before a later trace line of the waiting run, such as a rebase', async () => {
    const where = world();
    const at = (s: number) => `2026-10-16T00:00:0${s}.000Z`;
    const settled = { kind: 'pass' as const };
    say(where, { issue: 8, kind: 'approved', actor: 'morgan', trusted: true, at: at(5) });
    const { run } = services(where, []);
    await run(waiting(where));
    await run(
      Effect.flatMap(Store, s =>
        s.trace(
          'run-7',
          {
            at: at(2),
            step: 'implement',
            outcome: settled,
            run: { step: 'merge', status: 'waiting', tries: 0, rounds: {} },
          },
          { at: at(9), step: 'merge', applied: { proposal: { kind: 'label', add: ['x'] }, ok: true } }
        )
      )
    );
    const touched = await run(tick(merging, 7));
    expect(touched.map(r => [r.id, r.status])).toEqual([['run-7', 'done']]);
  });

  it('passes on an approval without taking the follow-up asks that came with it', async () => {
    const where = world();
    say(where, comment(8, 'morgan', true, '@agent please file a follow-up for the docs', '2026-10-16T00:00:05.000Z'));
    say(where, { issue: 8, kind: 'approved', actor: 'morgan', trusted: true, at: '2026-10-16T00:00:06.000Z' });
    const { specs, run } = services(where, [[start('b'), reply({ kind: 'comment', body: 'Filed.' })]]);
    await run(waiting(where));
    const touched = await run(tick(merging, 7));
    expect(touched.find(r => r.id === 'run-7')).toMatchObject({ status: 'done', said: [{ issue: 8 }] });
    expect(specs.map(s => s.prompt).join()).toContain('please file a follow-up for the docs');
  });

  it('asks instead of waiting for a merge when no pull request is open on the branch', async () => {
    const where = world();
    const flow = merging.workflows.issue;
    const { specs, run } = services(where, []);
    const start = { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), step: 'merge' };
    const parked = await run(runWorkflow(flow, start, merging));
    expect(parked).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(parked.reason).toMatch(/^No pull request is open for branch /);
    expect(specs).toHaveLength(0);
  });

  it('applies the push, then retries and parks as an engine error when a reply fails on the tracker', async () => {
    const where = world();
    const failing = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
          p.kind === 'comment' && p.body === 'boom'
            ? Effect.fail(new TrackerError({ status: 403, message: 'forbidden' }))
            : f.apply(n, p, work),
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const flow = small.workflows.issue!;
    const specs: SessionSpec[] = [];
    const recording = Layer.effect(
      Session,
      Effect.map(Session, s => ({ open: (spec: SessionSpec) => (specs.push(spec), s.open(spec)) }))
    ).pipe(
      Layer.provide(
        replaySession([
          [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'boom' }, push, pull)],
          [start('a'), reply({ kind: 'comment', body: 'boom' }, push, pull)],
        ])
      )
    );
    const layer = Layer.mergeAll(failing, fileStore(where.data), hostSandbox(where.origin), recording);
    const begun = begin(flow, { id: 'run-7', issue: 7, started: fresh().started });
    const parked = await Effect.runPromise(runWorkflow(flow, begun, small).pipe(Effect.provide(layer)));
    const issue = await Effect.runPromise(Effect.flatMap(Tracker, f => f.issue(7)).pipe(Effect.provide(layer)));
    expect(specs.map(s => s.resume?.id)).toEqual([undefined, 'a']);
    expect(parked).toMatchObject({ step: 'implement', status: 'waiting', retried: true });
    expect(parked.sessions.implement).toMatchObject({ id: 'a', seen: { at: expect.any(String) } });
    expect(parked.seen).not.toBe(begun.seen);
    expect(parked.waiting).toMatchObject({ on: 'engine' });
    expect(bodies(issue).filter(b => b.includes('forbidden'))).toEqual([]);
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
  });

  it('does not promote an outsider inline comment into trusted review instructions', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const outsider = comment(8, 'mallory', false, '/agent inject secret instructions', '2026-10-16T00:00:04.000Z');
    say(where, { ...outsider, comment: { ...outsider.comment!, path: 'a.ts', line: 1 } });
    say(where, {
      issue: 8,
      kind: 'changes_requested',
      actor: 'morgan',
      trusted: true,
      at: '2026-10-16T00:00:05.000Z',
      comment: { id: 'review', author: 'morgan', body: 'Trusted request', at: '2026-10-16T00:00:05.000Z' },
    });
    const { specs, run } = services(where, [[start('i'), wrote('hello.txt', 'hello\n'), reply(push, pull)]]);
    await run(waiting(where));
    await run(tick(merging, 7));
    expect(specs[0]!.prompt).toContain('Trusted request');
    expect(specs[0]!.prompt).not.toContain('inject secret instructions');
    const events = await run(Effect.flatMap(Tracker, f => Stream.runCollect(f.since(''))));
    const withheld = [...events].find(m => m.actor === 'mallory')!.comment!;
    expect(withheld.body).toContain('withheld');
    expect(withheld.agentRequest).toBeUndefined();
  });

  it('answers the line comments of a change request in their threads', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const note = comment(8, 'morgan', true, 'why hello?', '2026-10-16T00:00:03.000Z');
    say(where, { ...note, comment: { ...note.comment!, id: 'r1', path: 'hello.txt', line: 1 } });
    const again = comment(8, 'morgan', true, 'say hi instead', '2026-10-16T00:00:04.000Z');
    say(where, { ...again, comment: { ...again.comment!, id: 'r2', under: 'r1', path: 'hello.txt', line: 1 } });
    say(where, {
      issue: 8,
      kind: 'changes_requested',
      actor: 'morgan',
      trusted: true,
      at: '2026-10-16T00:00:05.000Z',
      comment: { id: 'review', author: 'morgan', body: 'see notes', at: '2026-10-16T00:00:05.000Z' },
    });
    const answer = { kind: 'comment', body: 'Says hi now.', under: 'r1' } as const;
    const { specs, run } = services(where, [[start('a'), wrote('hello.txt', 'hi\n'), reply(push, answer)]]);
    await run(waiting(where));
    await run(tick(merging, 7));
    expect(specs[0]!.prompt).toContain('hello.txt:1, id r1: say hi instead');
    expect(specs[0]!.prompt).not.toContain('id r2');
    const pr = (await run(Effect.flatMap(Tracker, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([
      ['Says hi now.', 'r1'],
    ]);
  });

  it('sends a run parked at merge with its rounds spent back on a new change request', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const issue = merging.workflows.issue;
    const capped = {
      ...merging,
      workflows: {
        issue: {
          ...issue,
          steps: issue.steps.map(s => (s.name === 'merge' ? { ...s, back: { to: 'implement', rounds: 1 } } : s)),
        },
      },
    };
    say(where, {
      issue: 8,
      kind: 'changes_requested',
      actor: 'morgan',
      trusted: true,
      at: '2026-10-16T00:00:05.000Z',
      comment: { id: 'review', author: 'morgan', body: 'rename bar', at: '2026-10-16T00:00:05.000Z' },
    });
    const { specs, run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)]]);
    await run(waiting(where));
    await run(
      Effect.flatMap(Store, s =>
        Effect.flatMap(s.get('run-7'), r => s.put({ ...r!, rounds: { merge: 1 }, reason: 'rename foo' }))
      )
    );
    await run(tick(capped, 7));
    expect(specs[0]!.prompt).toContain('the merge step sent this back: rename bar');
    expect(await run(Effect.flatMap(Store, s => s.get('run-7')))).toMatchObject({
      step: 'merge',
      status: 'waiting',
      rounds: { merge: 1 },
    });
  });

  it('uses back target limits for an aside and inherits graph CPUs', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent rerun the screenshots', '2026-10-16T00:00:05.000Z'));
    const configured = {
      ...merging,
      limits: { ...merging.limits, memory: '4g', cpus: 3 },
      workflows: {
        issue: {
          ...merging.workflows.issue,
          steps: merging.workflows.issue.steps.map(s => ({
            ...s,
            limits: s.name === 'implement' ? { memory: '8g' } : { memory: '16g', cpus: 6 },
          })),
        },
      },
    };
    const { specs, run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Will check.' })]]);
    const touched = await run(Effect.andThen(waiting(where), tick(configured, 7)));
    expect(touched).toMatchObject([{ id: 'run-7', step: 'merge', status: 'waiting' }]);
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({
      resume: { id: 'a' },
      fork: true,
      limits: { memory: '8g', cpus: 3 },
    });
    expect(configured.limits).toMatchObject({ memory: '4g', cpus: 3 });
  });

  it('sends a run waiting at merge back when the aside a mention starts proposes back, resuming its fork', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent please undo the greeting', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('f'), reply({ kind: 'comment', body: 'Will undo.' }, { kind: 'back', why: 'undo the greeting' })],
      [start('f'), wrote('hello.txt', 'hello\n'), reply(push, { kind: 'comment', body: 'Undone.' })],
    ]);
    const touched = await run(Effect.andThen(waiting(where), tick(merging, 7)));
    expect(touched.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'waiting']]);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ resume: { id: 'a' }, fork: true });
    expect(specs[0]!.prompt).toContain('please undo the greeting');
    expect(specs[1]!.resume?.id).toBe('f');
    expect(specs[1]!.fork).toBeUndefined();
    expect(specs[1]!.prompt).toMatch(
      /^the merge step sent this back: undo the greeting\n\n## New since you last looked/
    );
    expect(readFileSync(issuePath(where.tracker, 8, 'events.jsonl'), 'utf8')).toContain('Will undo.');
    expect(readFileSync(issuePath(where.tracker, 8, 'events.jsonl'), 'utf8')).toContain('Undone.');
    expect(readFileSync(issuePath(where.tracker, 7, 'events.jsonl'), 'utf8')).not.toContain('Undone.');
    const marks = readTrace(where.data, 'run-7').filter(t => t.step === 'merge');
    expect(marks.flatMap(t => ('prompt' in t && t.aside ? [t.aside] : []))).toEqual([
      { issue: 8, comment: '2026-10-16T00:00:05.000Z' },
    ]);
    expect(marks.flatMap(t => ('session' in t ? [!!t.session.aside] : []))).toEqual([true]);
    expect(readFileSync(issuePath(where.tracker, 8, 'reactions'), 'utf8')).toBe('eyes 2026-10-16T00:00:05.000Z\n');
    expect(reactions(where.data, 'run-7')).toEqual([true]);
  });

  it('runs a step fresh with its full prompt once its kept session fails to resume, and traces why', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent please undo the greeting', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('f'), reply({ kind: 'back', why: 'undo the greeting' })],
      [{ type: 'end', final: 'no session f', ended: 'error', exit: 1 }],
      [start('g'), wrote('hello.txt', 'hello\n'), reply(push)],
    ]);
    const touched = await run(Effect.andThen(waiting(where), tick(merging, 7)));
    expect(touched.map(r => [r.step, r.status, r.retried, r.sessions.implement?.id])).toEqual([
      ['merge', 'waiting', undefined, 'g'],
    ]);
    expect(specs.map(s => s.resume?.id)).toEqual(['a', 'f', undefined]);
    expect(specs[2]!.prompt).toContain('Add hello.txt.');
    expect(specs[2]!.prompt).toContain('undo the greeting');
    const sessions = readTrace(where.data, 'run-7').flatMap(t =>
      'session' in t && t.step === 'implement' ? [t.session] : []
    );
    expect(sessions).toMatchObject([
      { resumed: true, ended: 'error' },
      { id: 'g', resumed: false, dropped: 'no session f', ended: 'stop' },
    ]);
  });

  it('answers in a fresh session with the whole thread when the kept session ran on another harness', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent why hello?', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Asked for.' })]]);
    await run(
      Effect.andThen(
        waiting(where),
        Effect.flatMap(Store, s =>
          Effect.flatMap(s.get('run-7'), r =>
            s.put({ ...r!, sessions: { implement: { id: 'a', home: '/homes/a', harness: 'claude' } } })
          )
        )
      )
    );
    await run(tick(merging, 7));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.resume).toBeUndefined();
    expect(specs[0]!.fork).toBeUndefined();
    expect(specs[0]!.prompt).toContain('Add hello.txt.');
    expect(specs[0]!.prompt).toContain('why hello?');
    expect(readTrace(where.data, 'run-7').flatMap(t => ('session' in t ? [t.session] : []))).toMatchObject([
      { resumed: false, dropped: 'the session ran on claude', aside: true },
    ]);
  });

  it('replies under a review thread on the pull request when the change was asked on the issue', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const lined = comment(8, 'morgan', true, 'not this example', '2026-10-16T00:00:02.000Z');
    say(where, { ...lined, comment: { ...lined.comment!, id: 'r1', path: 'hello.txt', line: 1 } });
    say(where, comment(7, 'morgan', true, '/agent drop the example', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('f'), reply({ kind: 'comment', body: 'Will drop it.', under: 'r1' }, { kind: 'back', why: 'drop it' })],
      [start('f'), wrote('hello.txt', 'hello\n'), reply(push)],
    ]);
    await run(Effect.andThen(waiting(where), tick(merging, 7)));
    expect(specs).toHaveLength(2);
    expect(readFileSync(issuePath(where.tracker, 8, 'events.jsonl'), 'utf8')).toContain('Will drop it.');
    expect(readFileSync(issuePath(where.tracker, 7, 'events.jsonl'), 'utf8')).not.toContain('Will drop it.');
  });

  it.each([[{ kind: 'comment', body: 'Dropped it.' }], []] as Proposal[][])(
    'fails a sent back try that changes files and does not push them: %j',
    async (...said) => {
      const where = world();
      git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
      say(where, comment(8, 'morgan', true, '/agent drop the example', '2026-10-16T00:00:05.000Z'));
      const { specs, run } = services(where, [
        [start('f'), reply({ kind: 'comment', body: 'Will drop it.' }, { kind: 'back', why: 'drop it' })],
        [start('f'), wrote('hello.txt', 'hello\n'), reply(...said)],
        [start('f'), reply(push)],
      ]);
      await run(Effect.andThen(waiting(where), tick(merging, 7)));
      expect(specs).toHaveLength(3);
      expect(specs[2]!.prompt).toContain('files changed but nothing was pushed');
      expect(specs[2]!.prompt).toContain('{"kind":"push","branch"');
      expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    }
  );

  it('tells a try that changes files and sends a malformed push why it did not parse', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent drop the example', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('f'), reply({ kind: 'comment', body: 'Will drop it.' }, { kind: 'back', why: 'drop it' })],
      [start('f'), wrote('hello.txt', 'hello\n'), reply({ kind: 'push', message: 'drop it' } as Proposal)],
      [start('f'), reply(push)],
    ]);
    await run(Effect.andThen(waiting(where), tick(merging, 7)));
    expect(specs[2]!.prompt).toContain('proposal 1: write it as {"kind":"push","branch"');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
  });

  it('goes back when the aside proposes back, even if its reply cannot land', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent drop the example', '2026-10-16T00:00:05.000Z'));
    const specs: unknown[] = [];
    const failing = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
          p.kind === 'comment' && p.body === 'boom'
            ? Effect.fail(new TrackerError({ status: 403, message: 'forbidden' }))
            : f.apply(n, p, work),
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const recording = Layer.effect(
      Session,
      Effect.map(Session, s => ({ open: (spec: SessionSpec) => (specs.push(spec), s.open(spec)) }))
    ).pipe(
      Layer.provide(
        replaySession([
          [start('f'), reply({ kind: 'comment', body: 'boom' }, { kind: 'back', why: 'drop it' })],
          [start('f'), wrote('hello.txt', 'hello\n'), reply(push)],
        ])
      )
    );
    const layer = Layer.mergeAll(failing, fileStore(where.data), hostSandbox(where.origin), recording);
    await Effect.runPromise(Effect.andThen(waiting(where), tick(merging, 7)).pipe(Effect.provide(layer)));
    expect(specs).toHaveLength(2);
    expect((specs[1] as SessionSpec).prompt).toMatch(/^the merge step sent this back: drop it/);
  });

  it('consumes an approval arriving during an aside on the next tick', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent why the greeting?', '2026-10-16T00:00:05.000Z'));
    const { run } = services(
      where,
      [[start('f'), reply({ kind: 'comment', body: 'For the example.' })]],
      undefined,
      () => {
        say(where, { issue: 8, kind: 'approved', actor: 'morgan', trusted: true, at: '2026-10-16T00:00:06.000Z' });
      }
    );
    await run(waiting(where));
    writeIssueAt(
      issuePath(where.tracker, 8, 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: git(where.origin, 'rev-parse', 'agentgraph/7') })
    );
    await run(tick(merging, 7));
    await run(tick(merging, 7));
    const stored = await run(Effect.flatMap(Store, s => s.get('run-7')));
    expect(stored).toMatchObject({ status: 'done', seen: '2026-10-16T00:00:06.000Z' });
  });

  it.each(['error', 'cap', 'missing', 'refused', 'no-back', 'no-pull'])(
    'does not consume an unanswered aside: %s',
    async kind => {
      const where = world();
      git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
      const at = '2026-10-16T00:00:05.000Z';
      const failed: SessionEvent =
        kind === 'error' || kind === 'cap'
          ? { type: 'end', final: '', ended: kind, exit: 1 }
          : kind === 'missing'
            ? { type: 'end', final: 'No proposal.', ended: 'stop', exit: 0 }
            : reply({ kind: 'comment', body: 'Answer.', under: 'missing-thread' });
      const { run } = services(where, [
        [start('f'), failed],
        [start('f'), failed],
      ]);
      await run(waiting(where));
      const noBack = kind === 'no-back' || kind === 'no-pull';
      const flow = noBack
        ? {
            ...merging.workflows.issue,
            steps: merging.workflows.issue.steps.map(step => {
              if (step.name !== 'merge') return step;
              const { back: _back, ...rest } = step;
              return rest;
            }),
          }
        : merging.workflows.issue;
      const kit = { ...merging, workflows: { issue: flow } };
      if (kind === 'no-pull') {
        rmSync(issuePath(where.tracker, 8));
        rmSync(join(where.tracker, '8'), { recursive: true });
      }
      say(where, comment(kind === 'no-pull' ? 7 : 8, 'morgan', true, '/agent why?', at));
      await run(tick(kit, 7));
      expect((await run(Effect.flatMap(Store, s => s.get('run-7'))))?.seen).not.toBe(at);
      await run(tick(kit, 7));
      expect((await run(Effect.flatMap(Store, s => s.get('run-7'))))?.waiting?.on).toBe('engine');
      expect(readFileSync(issuePath(where.tracker, kind === 'no-pull' ? 7 : 8, 'events.jsonl'), 'utf8')).not.toContain(
        'Could not answer'
      );
    }
  );

  it('traces a sandbox start error while answering a waiting run', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    await services(where, []).run(waiting(where));
    writeIssueAt(
      issuePath(where.tracker, 8, 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: git(where.origin, 'rev-parse', 'agentgraph/7') })
    );
    say(where, comment(8, 'morgan', true, '/agent why the greeting?', '2026-10-16T00:00:05.000Z'));
    let first = true;
    const sandbox = Layer.effect(
      Sandbox,
      Effect.map(Sandbox, s => ({
        ...s,
        checkout: (...args: Parameters<typeof s.checkout>) => {
          if (!first) return s.checkout(...args);
          first = false;
          return Effect.fail(new SandboxError({ reason: 'host', detail: 'sandbox image is missing' }));
        },
      }))
    ).pipe(Layer.provide(hostSandbox(where.origin)));
    const layer = Layer.mergeAll(folderTracker(where.tracker), fileStore(where.data), sandbox, replaySession([]));
    await Effect.runPromise(tick(merging, 7).pipe(Effect.provide(layer)));
    expect(readTrace(where.data, 'run-7')).toContainEqual(
      expect.objectContaining({ outcome: { kind: 'ask', question: 'SandboxError: sandbox image is missing' } })
    );
  });

  it('retries an aside once, then pauses in the sticky without a separate reply', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent why the greeting?', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, []);
    await run(waiting(where));
    const stored = () => run(Effect.flatMap(Store, st => st.list({ issue: 7 }))).then(rs => rs[0]!);
    await run(tick(merging, 7));
    const first = await stored();
    expect(first).toMatchObject({ step: 'merge', status: 'waiting', retried: true });
    expect(first.seen).not.toBe('2026-10-16T00:00:05.000Z');
    expect(readFileSync(issuePath(where.tracker, 8, 'events.jsonl'), 'utf8')).not.toContain('Could not answer');
    await run(tick(merging, 7));
    const second = await stored();
    expect(second).toMatchObject({
      step: 'merge',
      status: 'waiting',
      waiting: { on: 'engine' },
      retried: true,
    });
    expect(second.seen).not.toBe('2026-10-16T00:00:05.000Z');
    expect(specs.map(s => !!s.resume)).toEqual([true, false, true, false]);
    await run(tick(merging, 7));
    expect(specs).toHaveLength(4);
    expect(readFileSync(issuePath(where.tracker, 8, 'events.jsonl'), 'utf8')).not.toContain('Could not answer');
    const resumed = services(where, [[start('f'), reply({ kind: 'comment', body: 'For the example.' })]]);
    await resumed.run(instruct(merging, { kind: 'resume', parked: true }));
    await resumed.run(tick(merging, 7));
    expect(resumed.specs).toHaveLength(1);
    expect((await stored()).reason).toBeUndefined();
  });

  describe('an aside answered by an agent without the grant', () => {
    const secret = 'checkout secret 42';
    const granting = (returns: Agent['returns']) => ({
      ...merging,
      agents: { ...merging.agents, implementor: { ...merging.agents.implementor!, returns } },
    });
    const trackerText = (where: ReturnType<typeof world>) =>
      readdirSync(where.tracker, { recursive: true, withFileTypes: true })
        .filter(f => f.isFile() && !f.parentPath.includes('origin.git'))
        .map(f => readFileSync(join(f.parentPath, f.name), 'utf8'))
        .join('\n');
    const answer = async (returns: Agent['returns'], said: Proposal) => {
      const where = world();
      git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
      say(where, comment(8, 'morgan', true, '/agent what changed?', '2026-10-16T00:00:05.000Z'));
      const { run } = services(where, [[start('f'), reply(said)]]);
      await run(Effect.andThen(waiting(where), tick(granting(returns), 7)));
      const stored = await run(Effect.flatMap(Store, st => st.get('run-7')));
      const asked = readTrace(where.data, 'run-7').flatMap(t =>
        'outcome' in t && t.outcome.kind === 'ask' && t.outcome.question.includes('may not propose')
          ? [t.outcome.question]
          : []
      );
      return { stored: stored!, asked, leaked: trackerText(where).includes(secret) };
    };

    it.each([
      { kind: 'comment', body: secret },
      { kind: 'label', add: [secret] },
      { kind: 'push', branch: 'agentgraph/7', message: secret },
      { kind: 'pull_request', branch: 'agentgraph/7', base: 'main', title: secret, body: secret },
      { kind: 'merge', number: 8, head: secret },
      { kind: 'issue', relation: 'follow-up', title: secret, body: secret },
      { kind: 'tell', issue: 7, text: secret },
    ] as Proposal[])('refuses its $kind and publishes none of it', async said => {
      const { stored, asked, leaked } = await answer([], said);
      expect([stored.step, stored.status, asked, leaked]).toEqual([
        'merge',
        'waiting',
        [`SessionStop: implement may not propose ${said.kind}`],
        false,
      ]);
    });

    it('posts its comment when its returns list comment', async () => {
      const { stored, asked, leaked } = await answer(['comment'], { kind: 'comment', body: secret });
      expect([stored.step, stored.status, asked, leaked]).toEqual(['merge', 'waiting', [], true]);
    });
  });
});
