import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';
import { ConfigProvider, Effect, Layer, Redacted, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { drive, instruct, issueDebounceMs, scanIssuesAndRunningRuns, tick } from '../src/engine.ts';
import { readEngineEnv, start as main, temporary } from '../src/main.ts';
import { fileForge, Forge, ForgeError } from '../src/forge.ts';
import type { Event } from '../src/event.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox } from '../src/sandbox.ts';
import { settings, type Settings } from '../src/services.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent, SessionSpec } from '../src/trace.ts';
import { begin, transition, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { hubOf, reply, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';
import {
  hub,
  removeAfter,
  world,
  push,
  pull,
  services,
  traceOf,
  reactions,
  bodies,
  driveStored,
  fresh,
  say,
  comment,
  pullRequest,
} from './world.ts';

describe('tick', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });

  it.each(['event', 'cli'])('leaves a locked run to its driver when another tick sees stop: %s', async source => {
    const where = world();
    const flow = { ...small.workflows.issue!, steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: [] })) };
    const kit = {
      ...small,
      workflows: { issue: flow },
      agents: {
        ...small.agents,
        implementor: {
          ...small.agents.implementor!,
          returns: [...small.agents.implementor!.returns, 'tell' as const],
        },
      },
    };
    const base = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), hostSandbox(where.origin));
    const turns = replaySession([[start('a'), reply({ kind: 'ask', question: 'Continue?' })]]);
    let during: Run['status'] | undefined;
    const session = Layer.effect(
      Session,
      Effect.gen(function* () {
        const f = yield* Forge;
        const store = yield* Store;
        const sandbox = yield* Sandbox;
        const s = yield* Session;
        let checked = false;
        return {
          open: (spec: SessionSpec) =>
            s.open(spec).pipe(
              Stream.tap(event => {
                if (event.type !== 'start' || checked) return Effect.void;
                checked = true;
                return Effect.gen(function* () {
                  if (source === 'event') where.human('/agent stop', '2026-10-16T00:00:05.000Z');
                  const incoming =
                    source === 'cli' ? instruct(kit, { kind: 'say', issue: 7, text: 'stop' }) : tick(kit, 7);
                  yield* incoming.pipe(
                    Effect.provideService(Forge, f),
                    Effect.provideService(Store, store),
                    Effect.provideService(Sandbox, sandbox),
                    Effect.provideService(Session, s)
                  );
                  during = (yield* store.get('run-7'))?.status;
                }).pipe(Effect.orDie);
              })
            ),
        };
      })
    ).pipe(Layer.provide(Layer.mergeAll(base, turns)));
    const done = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), kit).pipe(
        Effect.provide(Layer.mergeAll(base, session))
      )
    );
    expect(during).toBe('running');
    expect(done.status).toBe('stopped');
    if (source === 'cli') expect(traceOf(where.data, 'run-7').filter(t => 'spoken' in t)).toHaveLength(1);
  });

  it('begins a run from a trusted command, drives it, and begins again only on a new command', async () => {
    const where = world();
    const at = '2026-10-16T00:00:01.000Z';
    say(where, {
      issue: 7,
      kind: 'comment',
      actor: 'mallory[bot]',
      trusted: false,
      at,
      comment: { id: 'x', author: 'mallory[bot]', body: '/agent', at },
    });
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply(push)],
      [start('b'), reply({ kind: 'comment', body: 'Nothing left to do.' })],
    ]);
    const first = await run(tick(small));
    expect(first.map(r => [r.id, r.status])).toEqual([['issue-7-20261016000000000', 'done']]);
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(await run(tick(small))).toEqual([]);
    where.human('/agent once more', '2026-10-17T00:00:00.000Z');
    const second = await run(tick(small));
    expect(second.map(r => [r.id, r.status])).toEqual([['issue-7-20261017000000000', 'done']]);
    expect(specs).toHaveLength(2);
    expect(specs[1]!.prompt).toContain('@morgan: /agent once more');
    expect(readFileSync(join(where.forge, '7.reactions'), 'utf8')).toBe('');
    expect(reactions(where.data, first[0]!.id)).toEqual([
      [true, undefined],
      [true, '2026-10-16T00:00:00.000Z'],
    ]);
    expect(reactions(where.data, second[0]!.id)).toEqual([
      [true, undefined],
      [true, '2026-10-17T00:00:00.000Z'],
    ]);
  });

  it.each([
    [true, 'files changed but nothing was pushed'],
    [false, 'a pass needs a pull request or an ask'],
  ])(
    'fails a commanded first try that only comments while no pull request holds its work (edits %s)',
    async (edits, why) => {
      const where = world();
      const { specs, run } = services(where, [
        [start('a'), ...(edits ? [wrote('hello.txt', 'hello\n')] : []), reply({ kind: 'comment', body: 'Looked.' })],
        [start('a'), reply({ kind: 'ask', question: 'Push it?' })],
      ]);
      const [asked] = await run(tick(small));
      expect(asked).toMatchObject({ status: 'waiting', reason: 'Push it?' });
      expect(specs[0]!.prompt).not.toContain('answer it with comment proposals only');
      expect(specs[1]!.prompt).toContain(why);
    }
  );

  it('goes on past a commanded first step that may only comment while no pull request holds the work', async () => {
    const where = world();
    const flow = small.workflows.issue!;
    const triaged = {
      ...small,
      agents: {
        ...small.agents,
        triager: { ...small.agents.implementor!, name: 'triager', returns: ['comment' as const] },
      },
      workflows: {
        issue: {
          ...flow,
          steps: [{ ...flow.steps[0]!, name: 'triage', does: { agent: 'triager' }, checks: [] }, flow.steps[0]!],
        },
      },
    };
    const { specs, run } = services(where, [
      [start('a'), reply({ kind: 'comment', body: 'Looks like a parser bug.' })],
      [start('b'), reply({ kind: 'ask', question: 'Which parser?' })],
    ]);
    const [asked] = await run(tick(triaged));
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which parser?' });
    expect(specs[0]!.prompt).not.toContain('answer it with comment proposals only');
  });

  it('applies nothing from a reply with an invented reply kind and asks for every proposal again', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull, { kind: 'reply', body: 'Done.' } as never)],
      [start('a'), reply({ kind: 'ask', question: 'Again?' })],
    ]);
    await run(tick(small));
    expect(specs[1]!.prompt).toContain('use comment, it is posted under the thread you are answering');
    expect(specs[1]!.prompt).toContain('nothing from this reply was applied: send every proposal again');
    expect(git(where.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
  });

  it('keeps the worktree files of a parked run and puts them back when it reenters', async () => {
    const where = world();
    const flow = small.workflows.issue!;
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), wrote('bye.txt', 'bye\n'), reply(push)],
    ]);
    const kept = 'refs/agentgraph/runs/run-7';
    const [asked, done, saved] = await run(
      Effect.gen(function* () {
        const asked = yield* drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        const saved = git(where.origin, 'show', `${kept}:hello.txt`);
        return [
          asked,
          yield* driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small),
          saved,
        ];
      })
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Hello or hi?' });
    console.log(done!.step, done!.reason, JSON.stringify(bodies(await run(Effect.flatMap(Forge, f => f.issue(7))))));
    expect(saved).toBe('hello');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'show', 'agentgraph/7:bye.txt')).toBe('bye');
    expect(git(where.origin, 'log', '--format=%s', 'main..agentgraph/7')).toBe('Add hello');
    expect(git(where.origin, 'rev-parse', `${kept}^`)).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', `${kept}^2:hello.txt`)).toBe('hello');
  });

  const issue = small.workflows.issue!;
  const merging = {
    ...small,
    workflows: {
      issue: {
        ...issue,
        steps: [
          ...issue.steps,
          { name: 'merge', does: { wait: 'human' as const }, checks: [], tries: 1, back: { to: 'implement' } },
        ],
      },
    },
  };
  /** Run 7 waiting at merge with its implement session kept, and pull request #8 on its branch. */
  const waiting = (where: ReturnType<typeof world>) => {
    pullRequest(where);
    return Effect.flatMap(Store, s =>
      s.put({
        ...begin(merging.workflows.issue, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
        step: 'merge',
        status: 'waiting',
        sessions: { implement: { id: 'a', home: '/homes/a' } },
      })
    );
  };

  it.each([false, true])('does not replay published changes over a human revert (pending: %s)', async pending => {
    const where = world();
    const implementation = merging.workflows.issue.steps[0]!;
    const flow = pending
      ? {
          ...merging.workflows.issue,
          steps: [
            implementation,
            { ...implementation, name: 'draft', checks: [] },
            ...merging.workflows.issue.steps.slice(1),
          ],
        }
      : merging.workflows.issue;
    const kit = { ...merging, workflows: { issue: flow } };
    const first = services(where, [
      [start('a'), wrote('hello.txt', 'published\n'), reply(push, pull)],
      ...(pending
        ? [[start('d'), wrote('pending.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })]]
        : []),
    ]);
    const parked = await first.run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), kit));
    const seed = join(where.root, 'seed');
    git(seed, 'fetch', '-q', where.origin, 'agentgraph/7');
    git(seed, 'checkout', '-q', '--detach', 'FETCH_HEAD');
    git(seed, 'rm', '-q', 'hello.txt');
    git(seed, 'commit', '-qm', 'Human revert');
    git(seed, 'push', '-q', where.origin, 'HEAD:agentgraph/7');
    let resurrected = false;
    let kept = !pending;
    const next = services(where, [[start('b'), reply({ kind: 'ask', question: 'Ready?' })]], undefined, spec => {
      resurrected = existsSync(join(spec.dir, 'hello.txt'));
      if (pending) kept = existsSync(join(spec.dir, 'pending.txt'));
    });
    await next.run(driveStored(flow, { ...parked, step: pending ? 'draft' : 'implement', status: 'running' }, kit));
    expect(resurrected).toBe(false);
    expect(kept).toBe(true);
  });

  it('does not count restored work as a new edit in a comment-only session', async () => {
    const where = world();
    const seed = join(where.root, 'seed');
    writeFileSync(join(seed, 'hello.txt'), 'hello\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Greeting');
    git(seed, 'push', '-q', where.origin, 'HEAD:agentgraph/7');
    pullRequest(where);
    const flow = small.workflows.issue!;
    const { specs, run } = services(where, [
      [wrote('pending.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
      [reply({ kind: 'comment', body: 'Answer only' })],
      [reply({ kind: 'ask', question: 'Unexpected edit?' })],
    ]);
    const [done, issue] = await run(
      Effect.gen(function* () {
        const asked = yield* drive(
          flow,
          { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), said: [{ issue: 7 }] },
          small
        );
        const done = yield* driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'Just answer' }), small);
        return [done, yield* Effect.flatMap(Forge, f => f.issue(7))] as const;
      })
    );
    expect(done.status).toBe('done');
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume).toBeUndefined();
    expect(bodies(issue).some(body => body.split('\n\n')[0] === 'Answer only')).toBe(true);
    expect(git(where.origin, 'show', 'refs/agentgraph/runs/run-7:pending.txt')).toBe('pending');
    expect(git(where.origin, 'ls-tree', '--name-only', 'agentgraph/7')).not.toContain('pending.txt');
  });

  it('takes a queued CLI stop after a locked aside finishes', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent why?', '2026-10-16T00:00:05.000Z'));
    const kit = {
      ...merging,
      agents: {
        ...merging.agents,
        implementor: {
          ...merging.agents.implementor!,
          returns: [...merging.agents.implementor!.returns, 'tell' as const],
        },
      },
    };
    const base = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), hostSandbox(where.origin));
    const session = Layer.effect(
      Session,
      Effect.gen(function* () {
        const f = yield* Forge;
        const store = yield* Store;
        const sandbox = yield* Sandbox;
        const s = yield* Session;
        let sent = false;
        return {
          open: (spec: SessionSpec) =>
            s.open(spec).pipe(
              Stream.tap(event => {
                if (event.type !== 'start' || sent) return Effect.void;
                sent = true;
                return instruct(kit, { kind: 'say', issue: 8, text: 'stop' }).pipe(
                  Effect.provideService(Forge, f),
                  Effect.provideService(Store, store),
                  Effect.provideService(Sandbox, sandbox),
                  Effect.provideService(Session, s),
                  Effect.orDie
                );
              })
            ),
        };
      })
    ).pipe(
      Layer.provide(Layer.mergeAll(base, replaySession([[start('f'), reply({ kind: 'comment', body: 'Answer.' })]])))
    );
    const final = await Effect.runPromise(
      Effect.gen(function* () {
        yield* waiting(where);
        writeFileSync(
          join(where.forge, '8', 'pull.json'),
          JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: git(where.origin, 'rev-parse', 'agentgraph/7') })
        );
        yield* tick(kit, 7);
        expect((yield* Effect.flatMap(Store, store => store.get('run-7')))?.status).toBe('waiting');
        yield* tick(kit, 7);
        return yield* Effect.flatMap(Store, store => store.get('run-7'));
      }).pipe(Effect.provide(Layer.mergeAll(base, session)))
    );
    expect(final?.status).toBe('stopped');
    expect(traceOf(where.data, 'run-7').filter(t => 'spoken' in t && t.spoken.issue === 8)).toHaveLength(1);
  });

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
    const parked = await run(drive(flow, start, merging));
    expect(parked).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(parked.reason).toMatch(/^No pull request is open for branch /);
    expect(specs).toHaveLength(0);
  });

  it('applies the push, then asks with the error when a reply fails on the forge', async () => {
    const where = world();
    const failing = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
          p.kind === 'comment' && p.body === 'boom'
            ? Effect.fail(new ForgeError({ status: 403, message: 'forbidden' }))
            : f.apply(n, p, work),
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const flow = small.workflows.issue!;
    const layer = Layer.mergeAll(
      failing,
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession([[start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'boom' }, push)]])
    );
    const asked = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'GitHub failed: forbidden' });
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
    const { specs, run } = services(where, [[start('i'), wrote('hello.txt', 'hello\n'), reply(push)]]);
    await run(waiting(where));
    await run(tick(merging, 7));
    expect(specs[0]!.prompt).toContain('Trusted request');
    expect(specs[0]!.prompt).not.toContain('inject secret instructions');
    const events = await run(Effect.flatMap(Forge, f => Stream.runCollect(f.since(''))));
    const withheld = [...events].find(m => m.actor === 'mallory')!.comment!;
    expect(withheld.body).toContain('withheld');
    expect(withheld.said).toBeUndefined();
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
    const { specs, run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push)]]);
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

  it('sends a run waiting at merge back when the aside a mention starts proposes back, resuming its fork', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    say(where, comment(8, 'morgan', true, '/agent please undo the greeting', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('f'), reply({ kind: 'comment', body: 'Will undo.' }, { kind: 'back', why: 'undo the greeting' })],
      [start('f'), wrote('hello.txt', 'hello\n'), reply(push, { kind: 'comment', body: 'Undone.' })],
    ]);
    const touched = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    expect(touched.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'waiting']]);
    expect(specs).toHaveLength(2);
    expect(specs[0]).toMatchObject({ resume: { id: 'a' }, fork: true });
    expect(specs[0]!.prompt).toContain('please undo the greeting');
    expect(specs[1]!.resume?.id).toBe('f');
    expect(specs[1]!.fork).toBeUndefined();
    expect(specs[1]!.prompt).toMatch(
      /^the merge step sent this back: undo the greeting\n\n## New since you last looked/
    );
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain('Will undo.');
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain('Undone.');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).not.toContain('Undone.');
    const marks = traceOf(where.data, 'run-7').filter(t => t.step === 'merge');
    expect(marks.flatMap(t => ('prompt' in t && t.aside ? [t.aside] : []))).toEqual([
      { issue: 8, comment: '2026-10-16T00:00:05.000Z' },
    ]);
    expect(marks.flatMap(t => ('session' in t ? [!!t.session.aside] : []))).toEqual([true]);
    expect(readFileSync(join(where.forge, '8.reactions'), 'utf8')).toBe('');
    expect(reactions(where.data, 'run-7')).toEqual([
      [true, undefined],
      [true, '2026-10-16T00:00:05.000Z'],
    ]);
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
    writeFileSync(
      join(where.forge, '8', 'pull.json'),
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
        rmSync(join(where.forge, '8.md'));
        rmSync(join(where.forge, '8'), { recursive: true });
      }
      say(where, comment(kind === 'no-pull' ? 7 : 8, 'morgan', true, '/agent why?', at));
      await run(tick(kit, 7));
      expect((await run(Effect.flatMap(Store, s => s.get('run-7'))))?.seen).not.toBe(at);
      await run(tick(kit, 7));
      expect((await run(Effect.flatMap(Store, s => s.get('run-7'))))?.seen).toBe(at);
      expect(readFileSync(join(where.forge, `${kind === 'no-pull' ? 7 : 8}.jsonl`), 'utf8')).toContain(
        'Could not answer'
      );
    }
  );

  it('retries an aside that errors once, then answers the human with a short comment and moves on', async () => {
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
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).not.toContain('Could not answer');
    await run(tick(merging, 7));
    const second = await stored();
    expect(second).toMatchObject({ step: 'merge', status: 'waiting', seen: '2026-10-16T00:00:05.000Z' });
    expect(second.retried).toBeUndefined();
    expect(specs).toHaveLength(2);
    expect(readFileSync(join(where.forge, '8.jsonl'), 'utf8')).toContain(
      'Could not answer: SessionStop. Reply again to retry.'
    );
  });

  it('answers a waiting run started by a label on a command, without starting the command workflow', async () => {
    const where = world();
    const triage = { ...merging.workflows.issue, name: 'triage', on: { issues: { label: 'triage' } } };
    const both = { ...merging, workflows: { ...merging.workflows, triage } };
    say(where, comment(7, 'morgan', true, '/agent the second one', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'comment', body: 'Thanks.' })],
    ]);
    await run(
      Effect.flatMap(Store, s =>
        s.put({
          ...begin(triage, { id: 'triage-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }),
          status: 'waiting',
          reason: 'Which one?',
        })
      )
    );
    const touched = await run(tick(both, 7));
    expect(touched.map(r => r.id)).toEqual(['triage-7']);
    expect((await run(Effect.flatMap(Store, s => s.list({ issue: 7 })))).map(r => r.workflow)).toEqual(['triage']);
    expect(specs.map(s => s.prompt).join('\n')).toContain('the second one');
  });

  it('takes a burst on a waiting run as one answer, and a label starts nothing while another run holds the issue', async () => {
    const where = world();
    const triage = { ...merging.workflows.issue, name: 'triage', on: { issues: { label: 'triage' } } };
    const fix = { ...merging.workflows.issue, name: 'fix', on: { issues: { label: 'fix' } } };
    const all = { ...merging, workflows: { ...merging.workflows, triage, fix } };
    say(where, comment(7, 'morgan', true, '/agent the second one', '2026-10-16T00:00:05.000Z'));
    say(where, comment(7, 'ana', true, '/agent and keep it short', '2026-10-16T00:00:06.000Z'));
    say(where, { issue: 7, kind: 'label', actor: 'ana', trusted: true, at: '2026-10-16T00:00:07.000Z', label: 'fix' });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Short how?' })]]);
    const asked = { ...begin(triage, { id: 'triage-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }) };
    await run(Effect.flatMap(Store, s => s.put({ ...asked, status: 'waiting', reason: 'Which one?' })));
    await run(tick(all, 7));
    expect((await run(Effect.flatMap(Store, s => s.list({ issue: 7 })))).map(r => r.workflow)).toEqual(['triage']);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('the second one\n\nand keep it short');
  });

  it('waits for an issue to settle before a burst starts work, and never starts again on what a run took in', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)]]);
    where.human('/agent hello', new Date().toISOString());
    expect(await run(tick(small, undefined, false, issueDebounceMs))).toEqual([]);
    const [done] = await run(tick(small));
    console.log(done!.step, done!.reason, JSON.stringify(bodies(await run(Effect.flatMap(Forge, f => f.issue(7))))));
    expect(done!.seen! >= done!.started).toBe(true);
    expect(await run(tick(small))).toEqual([]);
    expect(specs).toHaveLength(1);
  });

  it('answers a question at merge from a fork of the work session, under its thread, and keeps waiting', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const at = '2026-10-16T00:00:05.000Z';
    const asked = 'so the greeting was already documented in the README?';
    say(where, {
      ...comment(8, 'morgan', true, `/agent ${asked}`, at),
      comment: { id: 'r1', author: 'morgan', body: `/agent ${asked}`, at, path: 'hello.txt', line: 1 },
    });
    const { specs, run } = services(where, [
      [
        start('f'),
        { type: 'usage', input: 4, output: 2, usd: 0.5 },
        reply({ kind: 'comment', body: 'No, README.md only says demo.' }),
      ],
    ]);
    const touched = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    expect(touched).toMatchObject([{ id: 'run-7', step: 'merge', status: 'waiting', usd: 0.5 }]);
    expect(touched[0]!.sessions).toEqual({ implement: { id: 'a', home: '/homes/a' } });
    expect(specs).toHaveLength(1);
    expect(specs[0]).toMatchObject({ resume: { id: 'a', home: '/homes/a' }, fork: true });
    expect(specs[0]!.prompt).toContain(asked);
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([
      ['No, README.md only says demo.', 'r1'],
    ]);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(git(where.origin, 'rev-parse', 'main'));
  });

  it('answers a burst of review comments once, under the newest thread, and holds none of them once answered', async () => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const line = (id: string, body: string, at: string): Event => ({
      ...comment(8, 'morgan', true, body, at),
      comment: { id, author: 'morgan', body, at, path: 'hello.txt', line: 1 },
    });
    say(where, line('r1', '/agent why hello?', '2026-10-16T00:00:05.000Z'));
    say(where, line('r2', '/agent and CHAT.md?', '2026-10-16T00:00:06.000Z'));
    const { run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Both asked for.' })]]);
    const [answered] = await run(Effect.zipRight(waiting(where), tick(merging, 7)));
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([
      ['Both asked for.', 'r2'],
    ]);
    expect(answered!.said).toEqual([{ issue: 8 }]);
  });

  it('replies to a plain comment on a thread with a finished run, not to one for someone else or on another thread', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '9.md'),
      '---\ntitle: Other\nstate: open\nauthor: morgan\nlabels: []\n---\n\nOther.\n'
    );
    say(where, comment(9, 'morgan', true, 'where is the PR?', '2026-10-16T00:00:02.000Z'));
    say(where, comment(7, 'morgan', true, '@alice can you look?', '2026-10-16T00:00:03.000Z'));
    say(where, comment(7, 'mallory', false, 'where is the PR?', '2026-10-16T00:00:04.000Z'));
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'No PR yet.' })]]);
    const done = { ...begin(issue, { id: 'issue-7-done', issue: 7, started: '2026-10-16T00:00:01.000Z' }) };
    await run(Effect.flatMap(Store, s => s.put({ ...done, status: 'done' })));
    const twice = {
      ...small,
      workflows: { issue: { ...issue, steps: [...issue.steps, { ...issue.steps[0]!, name: 'again' }] } },
    };
    expect(await run(tick(twice))).toEqual([]);
    where.human('/agent where is the PR?', '2026-10-16T00:00:05.000Z');
    const touched = await run(tick(twice));
    expect(touched.map(r => [r.id, r.status, r.said])).toEqual([['issue-7-20261016000005000', 'done', [{ issue: 7 }]]]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('@morgan: /agent where is the PR?');
    expect(specs[0]!.prompt).toContain('When it does not ask for work, answer it with comment proposals only');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).toContain('No PR yet.');
  });

  it('ignores mentions from untrusted people and its own comments, and stops on a command on the issue', async () => {
    const where = world();
    say(where, comment(8, 'mallory', false, '/agent undo everything', '2026-10-16T00:00:05.000Z'));
    say(where, comment(8, 'agentgraph[bot]', false, '/agent undo everything', '2026-10-16T00:00:06.000Z'));
    const { specs, run } = services(where, []);
    expect(await run(Effect.zipRight(waiting(where), tick(merging, 7)))).toEqual([]);
    where.human('/agent stop not needed', '2026-10-16T00:00:07.000Z');
    const stopped = await run(tick(merging, 7));
    expect(stopped.map(r => [r.id, r.status, r.reason])).toEqual([['run-7', 'stopped', 'not needed']]);
    expect(specs).toHaveLength(0);
  });

  it('restarts a finished run at the step a command names, keeping its answers', async () => {
    const where = world();
    const answers = [{ asked: 'Hello or hi?', said: 'hello' }];
    const { specs, run } = services(where, [[start('i'), reply({ kind: 'ask', question: 'Which file?' })]]);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'stopped', answers })));
    where.human('/agent restart implement', '2026-10-16T00:01:00.000Z');
    const touched = await run(tick(hub));
    expect(touched.map(r => [r.id, r.step, r.status, r.answers])).toEqual([
      ['issue-7-20261016000100000', 'implement', 'waiting', answers],
    ]);
    expect(specs.map(s => s.agent)).toEqual(['implementor']);
  });

  it('restarts a waiting run from the first step: the old run stops and a new one begins', async () => {
    const where = world();
    const answers = [{ asked: 'Hello or hi?', said: 'hello' }];
    const { run } = services(where, [[start('t'), reply({ kind: 'ask', question: 'Which file?' })]]);
    await run(
      Effect.flatMap(Store, s =>
        s.put({ ...fresh(), step: 'implement', status: 'waiting', reason: 'Hello or hi?', answers })
      )
    );
    where.human('/agent restart', '2026-10-16T00:01:00.000Z');
    await run(tick(hub));
    const stored = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored.map(r => [r.id, r.step, r.status, r.reason]).sort()).toEqual([
      ['issue-7-20261016000100000', 'triage', 'waiting', 'Which file?'],
      ['run-7', 'implement', 'stopped', 'a human restarted it'],
    ]);
    expect(stored.find(r => r.id !== 'run-7')!.answers).toEqual(answers);
  });

  it('ends a run waiting at merge done when its pull request is merged and its issue closed with it', async () => {
    const where = world();
    const { run } = services(where, []);
    await run(waiting(where));
    const at = '2026-10-16T00:00:05.000Z';
    for (const n of [7, 8]) {
      const file = join(where.forge, `${n}.md`);
      writeFileSync(file, readFileSync(file, 'utf8').replace('state: open', `state: ${n === 7 ? 'closed' : 'merged'}`));
    }
    say(where, { issue: 7, kind: 'closed', actor: 'morgan', trusted: true, at });
    say(where, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at });
    const swept = await run(scanIssuesAndRunningRuns(merging));
    expect(swept.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'done']]);
  });
});

describe('start with one issue', () => {
  it('reads the App env file, loads the hub, drives the issue to the merge wait, then reenters on the merge', async () => {
    const where = world();
    const key = join(where.root, 'app.pem');
    writeFileSync(key, 'PEM');
    writeFileSync(
      join(where.root, 'app.env'),
      `AGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_SLUG=stx-agentgraph\nAGENTGRAPH_APP_KEY_FILE="${key}"\nAGENTGRAPH_INSTALLATION_ID=7\n`
    );
    const sandbox = join(import.meta.dirname, '..', 'examples', 'sandbox');
    const env = {
      AGENTGRAPH_APP_ENV: join(where.root, 'app.env'),
      AGENTGRAPH_PROXY_KEYS: 'implementor=k1,reviewer=k2',
      AGENTGRAPH_HUB: sandbox,
    };
    Object.assign(process.env, env);
    const seen: Settings[] = [];
    const fix: Proposal = { ...push, message: 'feat: add hello' };
    const turns = [
      [start('i'), wrote('hello.txt', 'TODO\n'), reply(fix)],
      [start('i'), wrote('hello.txt', 'hello\n'), reply(fix)],
      [start('r'), reply({ kind: 'comment', body: 'Looks right.' })],
    ];
    const doubles = (s: Settings) => {
      seen.push(s);
      return Layer.mergeAll(fileForge(where.forge), fileStore(s.data), hostSandbox(where.origin), replaySession(turns));
    };
    const one = { hub: sandbox, issue: 7, data: where.data };
    writeFileSync(join(where.forge, '7.jsonl'), '');
    say(where, {
      issue: 7,
      kind: 'label',
      label: 'agent:ready',
      actor: 'morgan',
      trusted: true,
      at: new Date().toISOString(),
    });
    try {
      const parked = await main(one, doubles);
      expect(parked.map(r => [r.step, r.status, r.tries])).toEqual([['merge', 'waiting', 0]]);
      expect(seen[0]).toMatchObject({
        repo: 'acme/sandbox',
        data: where.data,
        forge: { id: '42' },
      });
      expect(Redacted.value((seen[0]!.forge as { key: Redacted.Redacted }).key)).toBe('PEM');
      expect(Redacted.value(seen[0]!.proxy.keys)).toBe('implementor=k1,reviewer=k2');
      expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');

      const later = new Date(Date.now() + 1000).toISOString();
      say(where, { issue: 7, kind: 'merged', actor: 'morgan', trusted: true, at: later });
      const done = await main(one, doubles);
      expect(done.map(r => [r.id, r.status])).toEqual([[parked[0]!.id, 'done']]);
    } finally {
      for (const name of Object.keys(env)) delete process.env[name];
    }
  });
});

describe('temporary', () => {
  it('names a data dir under a temp dir, by its own path or through a link, and its mirror', () => {
    const home = mkdtempSync(join(homedir(), '.agentgraph-test-'));
    removeAfter(home);
    const linked = join(home, 'data');
    symlinkSync('/tmp', linked);
    expect(temporary('/tmp/agentgraph-data')).toEqual(['/tmp/agentgraph-data', '/tmp/agentgraph-data/mirror.git']);
    expect(temporary(linked)).toEqual([linked, join(linked, 'mirror.git')]);
    expect(temporary(join(homedir(), '.agentgraph'))).toEqual([]);
  });
});

describe('readEngineEnv', () => {
  const file = (text: string) => {
    const dir = mkdtempSync(join(tmpdir(), 'agentgraph-env-'));
    removeAfter(dir);
    writeFileSync(join(dir, 'key.pem'), 'PEM');
    writeFileSync(join(dir, 'keys'), 'implementor=k1');
    writeFileSync(join(dir, 'app.env'), text.replaceAll('$DIR', dir));
    return { dir, env: join(dir, 'app.env') };
  };
  const withShell = async <A>(vars: Record<string, string>, read: () => Promise<A>) => {
    Object.assign(process.env, vars);
    try {
      return await read();
    } finally {
      for (const name of Object.keys(vars)) delete process.env[name];
    }
  };

  it('reads quotes, comments, export and the key file the App env file names', async () => {
    const { env } = file(
      '# app\nexport AGENTGRAPH_APP_ID=42\nAGENTGRAPH_REPO="o/r" # inline\nAGENTGRAPH_APP_KEY_FILE=\'$DIR/key.pem\'\n'
    );
    expect(await withShell({ AGENTGRAPH_APP_ENV: env }, () => readEngineEnv())).toMatchObject({
      AGENTGRAPH_APP_ID: '42',
      AGENTGRAPH_REPO: 'o/r',
      AGENTGRAPH_APP_KEY: 'PEM',
    });
  });

  it('reads a NAME_FILE the shell or the defaults set, and only for secret settings and session variables', async () => {
    const { dir } = file('');
    const shell = {
      AGENTGRAPH_APP_KEY_FILE: join(dir, 'key.pem'),
      AGENTGRAPH_REPO_FILE: join(dir, 'key.pem'),
      AGENTGRAPH_SESSION_ENV: 'CLAUDE_CODE_OAUTH_TOKEN',
      CLAUDE_CODE_OAUTH_TOKEN_FILE: join(dir, 'keys'),
    };
    const env = await withShell(shell, () => readEngineEnv({ AGENTGRAPH_PROXY_KEYS_FILE: join(dir, 'keys') }));
    expect(env).toMatchObject({
      AGENTGRAPH_APP_KEY: 'PEM',
      AGENTGRAPH_PROXY_KEYS: 'implementor=k1',
      CLAUDE_CODE_OAUTH_TOKEN: 'implementor=k1',
    });
    expect(env.AGENTGRAPH_REPO).toBeUndefined();
  });

  it('lets the App env file beat the shell and the shell beat the defaults, each with its own NAME_FILE', async () => {
    const { dir, env } = file('AGENTGRAPH_PROXY_URL=from-app\n');
    const shell = { AGENTGRAPH_APP_ENV: env, AGENTGRAPH_PROXY_URL: 'from-shell', AGENTGRAPH_PROXY_KEYS: 'from-shell' };
    const defaults = {
      AGENTGRAPH_PROXY_URL: 'from-defaults',
      AGENTGRAPH_PROXY_KEYS_FILE: join(dir, 'keys'),
      AGENTGRAPH_EVERY: '9',
    };
    expect(await withShell(shell, () => readEngineEnv(defaults))).toMatchObject({
      AGENTGRAPH_PROXY_URL: 'from-app',
      AGENTGRAPH_PROXY_KEYS: 'from-shell',
      AGENTGRAPH_EVERY: '9',
    });
  });

  it('reads the key from a one-shot pipe', async () => {
    const { dir } = file('');
    const pipe = join(dir, 'pipe');
    execFileSync('mkfifo', [pipe]);
    const writer = spawn(process.execPath, ['-e', `require('fs').writeFileSync(${JSON.stringify(pipe)}, 'PEM')`]);
    expect((await withShell({ AGENTGRAPH_APP_KEY_FILE: pipe }, () => readEngineEnv())).AGENTGRAPH_APP_KEY).toBe('PEM');
    writer.kill();
  });

  it('reads only the key file of the source that wins', async () => {
    const env = await withShell({ AGENTGRAPH_APP_KEY: 'from-shell' }, () =>
      readEngineEnv({ AGENTGRAPH_APP_KEY_FILE: '/nonexistent/key.pem' })
    );
    expect(env.AGENTGRAPH_APP_KEY).toBe('from-shell');
  });

  it('finds the App env file an instance names', async () => {
    const { env } = file('AGENTGRAPH_APP_ID=42\n');
    expect(await withShell({}, () => readEngineEnv({ AGENTGRAPH_APP_ENV: env }))).toMatchObject({
      AGENTGRAPH_APP_ID: '42',
    });
  });

  it('leaves a missing required setting to fail by name', async () => {
    const { env } = file('AGENTGRAPH_APP_ID=42\nAGENTGRAPH_APP_KEY_FILE=$DIR/key.pem\n');
    const { AGENTGRAPH_REPO: _, ...vars } = await withShell({ AGENTGRAPH_APP_ENV: env }, () => readEngineEnv());
    const read = Effect.withConfigProvider(settings, ConfigProvider.fromMap(new Map(Object.entries(vars))));
    await expect(Effect.runPromise(read)).rejects.toThrow(/AGENTGRAPH_REPO/);
  });
});

describe('scanIssuesAndRunningRuns', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });

  it('drives a commanded issue and a parked one with a new answer, and skips an unmarked one and one waiting with nothing new', async () => {
    const where = world();
    for (const n of [8, 9, 10])
      writeFileSync(
        join(where.forge, `${n}.md`),
        `---\ntitle: Issue ${n}\nstate: open\nauthor: morgan\nlabels: []\n---\n\nBody ${n}.\n`
      );
    const at = '2026-10-16T00:00:00.000Z';
    const parked = (issue: number, status: Run['status']): Run => ({
      ...begin(small.workflows.issue!, { id: `run-${issue}`, issue, started: at }),
      status,
    });
    const answer = '2026-10-16T00:00:05.000Z';
    say(where, {
      issue: 8,
      kind: 'comment',
      actor: 'morgan',
      trusted: true,
      at: answer,
      comment: { id: 'a', author: 'morgan', body: '/agent hi', at: answer },
    });
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Done?' })],
      [start('b'), wrote('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Done?' })],
    ]);
    for (const r of [parked(8, 'waiting'), parked(9, 'waiting')]) {
      mkdirSync(join(where.data, r.id), { recursive: true });
      writeFileSync(join(where.data, r.id, 'run.json'), JSON.stringify(r));
    }
    const touched = await run(scanIssuesAndRunningRuns(small));
    expect(touched.map(r => r.issue).sort()).toEqual([7, 8]);
    expect(touched.find(r => r.issue === 9)).toBeUndefined();
    expect(await run(Effect.flatMap(Store, s => s.list({ issue: 10 })))).toEqual([]);
    expect(specs).toHaveLength(2);
    expect(specs.map(s => s.prompt).join('\n')).toContain('hi');
    expect(await run(Effect.flatMap(Store, s => s.read('run-9').pipe(Stream.runCollect)))).toHaveProperty('length', 0);
  });

  it('resumes a finished run on a comment that the repo-wide look has already passed', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '9.md'),
      '---\ntitle: Issue 9\nstate: open\nauthor: morgan\nlabels: []\n---\n\nBody 9.\n'
    );
    const done = (issue: number, started: string): Run => ({
      ...begin(small.workflows.issue!, { id: `run-${issue}`, issue, started }),
      status: 'done',
    });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'gh-pages it is.' })]]);
    await run(
      Effect.flatMap(Store, s =>
        Effect.forEach([done(7, '2026-10-16T00:00:00.000Z'), done(9, '2026-10-19T00:00:00.000Z')], s.put)
      )
    );
    where.human('/agent use gh-pages', '2026-10-17T00:00:00.000Z');
    expect(await run(tick(small))).toEqual([]);
    const touched = await run(scanIssuesAndRunningRuns(small));
    expect(touched.map(r => [r.id, r.status])).toEqual([['issue-7-20261017000000000', 'done']]);
    expect(specs[0]!.prompt).toContain('use gh-pages');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).toContain('gh-pages it is.');
  });

  it('looks at issues side by side, up to limits.parallel', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Issue 8\nstate: open\nauthor: morgan\nlabels: []\n---\n\nBody.\n'
    );
    say(where, comment(8, 'morgan', true, '/agent', '2026-10-16T00:00:00.000Z'));
    let open = 0;
    let most = 0;
    const slow = Layer.succeed(Session, {
      open: () =>
        Stream.fromEffect(
          Effect.acquireUseRelease(
            Effect.sync(() => (most = Math.max(most, ++open))),
            () => Effect.sleep('200 millis'),
            () => Effect.sync(() => open--)
          )
        ).pipe(Stream.flatMap(() => Stream.make(start('s'), reply({ kind: 'ask', question: 'Which file?' })))),
    });
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), hostSandbox(where.origin), slow);
    const touched = await Effect.runPromise(scanIssuesAndRunningRuns(small).pipe(Effect.provide(layer)));
    expect(touched.map(r => [r.issue, r.status]).sort()).toEqual([
      [7, 'waiting'],
      [8, 'waiting'],
    ]);
    expect(most).toBe(2);
  });
});
