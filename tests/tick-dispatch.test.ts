import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { instruct, tick } from '../src/run/trigger.ts';
import { folderTracker, Tracker } from '../src/tracker.ts';
import { Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionSpec } from '../src/trace.ts';
import { begin, transition, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { reply, start, wrote } from './fixtures.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';
import {
  world,
  push,
  pull,
  services,
  readTrace,
  reactions,
  bodies,
  driveStored,
  fresh,
  say,
  comment,
  pullRequest,
} from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';

import { small, merging, waiting } from './tick-fixtures.ts';

describe('tick', () => {
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
    const base = Layer.mergeAll(folderTracker(where.tracker), fileStore(where.data), hostSandbox(where.origin));
    const turns = replaySession([[start('a'), reply({ kind: 'ask', question: 'Continue?' })]]);
    let during: Run['status'] | undefined;
    const session = Layer.effect(
      Session,
      Effect.gen(function* () {
        const f = yield* Tracker;
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
                  if (source === 'event') where.human('/agent:stop', '2026-10-16T00:00:05.000Z');
                  const incoming =
                    source === 'cli' ? instruct(kit, { kind: 'say', issue: 7, text: ':stop' }) : tick(kit, 7);
                  yield* incoming.pipe(
                    Effect.provideService(Tracker, f),
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
      runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), kit).pipe(
        Effect.provide(Layer.mergeAll(base, session))
      )
    );
    expect(during).toBe('running');
    expect(done.status).toBe('stopped');
    if (source === 'cli') expect(readTrace(where.data, 'run-7').filter(t => 'spoken' in t)).toHaveLength(1);
  });

  it('persists caller metadata on dispatch and ordinary tick starts before the first trace', async () => {
    const where = world();
    const meta = { engine: { origin: { plugin: 'bench', version: 'v1', job: 'smoke', input: null } } };
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Continue?' })]]);
    const [begun] = await run(instruct(small, { kind: 'dispatch', workflow: 'issue', issue: 7 }, meta));
    expect(readTrace(where.data, begun!.id)[0]).toMatchObject({ saved: { meta } });
    const other = world();
    const direct = services(other, [[start('b'), reply({ kind: 'ask', question: 'Continue?' })]]);
    const [ticked] = await direct.run(tick(small, 7, false, 0, meta));
    expect(readTrace(other.data, ticked!.id)[0]).toMatchObject({ saved: { meta } });
  });

  it.each(['waiting', 'running'] as const)('keeps pending input metadata until acceptance while %s', async status => {
    const where = world();
    const origin = { plugin: 'bench', version: 'v1', job: 'smoke', input: null };
    const caller = { plugin: 'tune', version: 'v2', job: 'candidate', input: { answer: 1 } };
    const at = '2026-10-17T00:00:00.000Z';
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Next?' })]]);
    await run(
      Effect.flatMap(Store, store =>
        store.put({
          ...begin(small.workflows.issue!, { id: 'run-7', issue: 7, started: fresh().started }),
          status,
          reason: 'Continue?',
          meta: { engine: { origin } },
        })
      )
    );
    await run(
      Effect.flatMap(Store, store =>
        store.trace('run-7', {
          at,
          step: 'implement',
          meta: { engine: { origin: caller }, tune: { candidate: 'next' } },
          spoken: {
            source: 'cli',
            kind: 'comment',
            issue: 7,
            actor: 'cli',
            trusted: true,
            at,
            comment: { id: '', author: 'cli', body: '/agent continue', agentRequest: 'continue', at },
          },
        })
      )
    );
    const before = await run(Effect.flatMap(Store, store => store.get('run-7')));
    expect(before!.meta).toEqual({ engine: { origin } });
    await run(tick(small, 7));
    const after = await run(Effect.flatMap(Store, store => store.get('run-7')));
    expect(after!.meta).toEqual({ engine: { origin, continued: { ...caller, at } }, tune: { candidate: 'next' } });
    expect(await run(tick(small, 7))).toEqual([]);
  });

  it('rejects invalid metadata before dispatch records anything', async () => {
    const where = world();
    const { run } = services(where, []);
    await expect(
      run(instruct(small, { kind: 'dispatch', workflow: 'issue', issue: 7 }, { bench: undefined } as never))
    ).rejects.toThrow();
    expect(await run(Effect.flatMap(Store, store => store.list()))).toEqual([]);
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
      [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
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
    expect(readFileSync(issuePath(where.tracker, 7, 'reactions'), 'utf8')).toBe('');
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

  it('fails a retry that pushes without the pull request its failed first try proposed', async () => {
    const where = world();
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'TODO\n'), reply(push, pull)],
      [start('a'), wrote('hello.txt', 'hello\n'), reply(push, { kind: 'comment', body: 'Dropped the TODO.' })],
    ]);
    const [parked] = await run(tick(small));
    expect(parked).toMatchObject({ status: 'waiting', reason: 'a pass needs a pull request or an ask' });
    expect(specs[1]!.prompt).toContain('answer them by changing the code, not with a comment');
    expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))))).not.toContain('Dropped the TODO.');
  });

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
    expect(specs[1]!.prompt).toContain('Nothing from this reply was applied');
    expect(git(where.origin, 'branch', '--list', 'agentgraph/7')).toBe('');
  });

  it('keeps the worktree files of a parked run and puts them back when it reenters', async () => {
    const where = world();
    const flow = small.workflows.issue!;
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), wrote('bye.txt', 'bye\n'), reply(push, pull)],
    ]);
    const kept = 'refs/agentgraph/runs/run-7';
    const [asked, , saved] = await run(
      Effect.gen(function* () {
        const asked = yield* runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        const saved = git(where.origin, 'show', `${kept}:hello.txt`);
        return [
          asked,
          yield* driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small),
          saved,
        ];
      })
    );
    expect(asked).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Hello or hi?' });
    expect(saved).toBe('hello');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'show', 'agentgraph/7:bye.txt')).toBe('bye');
    expect(git(where.origin, 'log', '--format=%s', 'main..agentgraph/7')).toBe('Add hello');
    expect(git(where.origin, 'rev-parse', `${kept}^`)).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', `${kept}^2:hello.txt`)).toBe('hello');
  });

  it.each(['a-retro', 'z-retro'])('tells the work run at merge to go back beside live %s', async id => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
    const step = { ...merging.workflows.issue.steps[0]!, checks: [] };
    const router = { ...merging.workflows.issue, name: 'router', on: { issue_comment: {} }, steps: [step] };
    const retro = { ...router, name: 'retro', on: { feedback: {} } };
    const kit = {
      ...merging,
      workflows: { ...merging.workflows, router, retro },
      agents: {
        ...merging.agents,
        implementor: { ...merging.agents.implementor!, returns: ['tell' as const, 'ask' as const] },
      },
    };
    const text = 'Add screenshots and rewrite the description';
    const { run } = services(where, [[start('router'), reply({ kind: 'tell', issue: 7, text })]]);
    await run(waiting(where));
    const before = {
      ...begin(retro, { id, issue: 7, started: fresh().started }),
      status: 'waiting' as const,
      reason: 'Search issues?',
    };
    await run(Effect.flatMap(Store, s => s.put(before)));
    await run(runWorkflow(router, begin(router, { id: 'router-7', issue: 7, started: fresh().started }), kit));
    expect(readTrace(where.data, 'run-7').flatMap(t => ('told' in t ? [t.told] : []))).toEqual([
      { text, by: 'router-7' },
    ]);
    expect(readTrace(where.data, id).filter(t => 'told' in t)).toEqual([]);
    const resumed = services(where, [[start('a'), reply({ kind: 'ask', question: 'Which page?' })]]);
    await resumed.run(tick(kit, 7));
    expect(await run(Effect.flatMap(Store, s => s.get(id)))).toEqual(before);
    expect(await run(Effect.flatMap(Store, s => s.get('run-7')))).toMatchObject({
      step: 'implement',
      status: 'waiting',
      reason: 'Which page?',
    });
    expect(resumed.specs).toHaveLength(1);
    expect(resumed.specs[0]).toMatchObject({ resume: { id: 'a' } });
    expect(resumed.specs[0]!.fork).toBeUndefined();
    expect(resumed.specs[0]!.prompt).toContain(`the merge step sent this back: ${text}`);
  });

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
    const parked = await first.run(
      runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), kit)
    );
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
        const asked = yield* runWorkflow(
          flow,
          { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), said: [{ issue: 7 }] },
          small
        );
        const done = yield* driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'Just answer' }), small);
        return [done, yield* Effect.flatMap(Tracker, f => f.issue(7))] as const;
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
    const base = Layer.mergeAll(folderTracker(where.tracker), fileStore(where.data), hostSandbox(where.origin));
    const session = Layer.effect(
      Session,
      Effect.gen(function* () {
        const f = yield* Tracker;
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
                return instruct(kit, { kind: 'say', issue: 8, text: ':stop' }).pipe(
                  Effect.provideService(Tracker, f),
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
        writeIssueAt(
          issuePath(where.tracker, 8, 'pull.json'),
          JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: git(where.origin, 'rev-parse', 'agentgraph/7') })
        );
        yield* tick(kit, 7);
        expect((yield* Effect.flatMap(Store, store => store.get('run-7')))?.status).toBe('waiting');
        yield* tick(kit, 7);
        return yield* Effect.flatMap(Store, store => store.get('run-7'));
      }).pipe(Effect.provide(Layer.mergeAll(base, session)))
    );
    expect(final?.status).toBe('stopped');
    expect(readTrace(where.data, 'run-7').filter(t => 'spoken' in t && t.spoken.issue === 8)).toHaveLength(1);
  });
});
