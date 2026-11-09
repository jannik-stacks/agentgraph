import { existsSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { folderTracker, Tracker } from '../src/tracker.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox } from '../src/sandbox.ts';
import { fileStore } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { begin } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, start, wrote } from './fixtures.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';
import { world, push, pull, services, readTrace, driveStored, fresh, pullRequest } from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';

describe('a run branch that moved', () => {
  const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
  const flow = {
    ...small.workflows.issue!,
    steps: small.workflows.issue!.steps.map(s => ({ ...s, checks: ['types'] })),
  };

  it.each([false, true])(
    'rebases saved edits onto the branch tip before the agent starts (conflict: %s)',
    async conflict => {
      const where = world();
      git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
      const first = services(where, [
        [start('a'), wrote('hello.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
      ]);
      const parked = await first.run(
        runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
      );
      const mover = join(where.root, 'mover');
      git(where.root, 'clone', '-q', where.origin, mover);
      writeFileSync(join(mover, conflict ? 'hello.txt' : 'other.txt'), 'upstream\n');
      git(mover, 'add', '-A');
      git(mover, 'commit', '-qm', 'Other session');
      git(mover, 'push', '-q', 'origin', 'HEAD:agentgraph/7');
      const tip = git(mover, 'rev-parse', 'HEAD');
      let before = '';
      const next = services(
        where,
        [[start('a'), ...(conflict ? [wrote('hello.txt', 'resolved\n')] : []), reply(push, pull)]],
        undefined,
        spec => {
          before = readFileSync(join(spec.dir, 'hello.txt'), 'utf8');
          if (!conflict) expect(readFileSync(join(spec.dir, 'other.txt'), 'utf8')).toBe('upstream\n');
        }
      );
      const { reason: _reason, ...resumed } = parked;
      const done = await next.run(driveStored(flow, { ...resumed, status: 'running' }, small));
      expect(done.status).toBe('done');
      expect(next.specs).toHaveLength(1);
      expect(before).toMatch(conflict ? /<<<<<<<[\s\S]*upstream[\s\S]*pending/ : /^pending\n$/);
      if (conflict) expect(next.specs[0]!.prompt).toContain('Resolve each conflict');
      expect(git(where.origin, 'rev-parse', 'agentgraph/7^')).toBe(tip);
      expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe(conflict ? 'resolved' : 'pending');
      const rebases = readTrace(where.data, 'run-7').flatMap(t =>
        'applied' in t && t.applied.proposal.kind === 'rebase' ? [t.applied.ok] : []
      );
      expect(rebases).toEqual([!conflict]);
    }
  );

  it('walks again from the branch tip when the tracker refuses a push as moved, whatever its reason says', async () => {
    const where = world();
    let refused = false;
    const tracker = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
          p.kind === 'push' && !refused
            ? Effect.sync(() => ((refused = true), { proposal: p, ok: false, moved: true as const, reason: 'gone' }))
            : f.apply(n, p, work),
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const layer = Layer.mergeAll(
      tracker,
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession([
        [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
        [start('a'), reply(push, pull)],
      ])
    );
    const done = await Effect.runPromise(
      runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(
        Effect.provide(layer)
      )
    );
    expect(done.status).toBe('done');
    expect(readTrace(where.data, 'run-7').filter(t => 'outcome' in t && t.outcome.kind === 'failed')).toEqual([]);
  });

  it('keeps restored edits when following a new base on the first try', async () => {
    const where = world();
    const seed = join(where.root, 'seed');
    writeFileSync(join(seed, 'hello.txt'), 'hello\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Greeting');
    git(seed, 'push', '-q', where.origin, 'HEAD:agentgraph/7');
    const first = services(where, [
      [start('a'), wrote('pending.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
    ]);
    const parked = await first.run(
      runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
    );
    git(seed, 'checkout', '-q', '--detach', git(where.origin, 'rev-parse', 'main'));
    writeFileSync(join(seed, 'other.txt'), 'upstream\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Base moved');
    git(seed, 'push', '-q', where.origin, 'HEAD:main');
    const onto = git(seed, 'rev-parse', 'HEAD');
    let pending = false;
    const next = services(where, [[start('a'), reply(push, pull)]], undefined, spec => {
      pending = existsSync(join(spec.dir, 'pending.txt'));
    });
    const done = await next.run(
      driveStored(flow, { ...parked, status: 'running', tries: 0, onto: { sha: onto } }, small)
    );
    expect(pending).toBe(true);
    expect(done.status).toBe('done');
    expect(git(where.origin, 'show', 'agentgraph/7:pending.txt')).toBe('pending');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
  });

  it.each([0, 1])('replays saved work onto the rebased tip before try %s', async tries => {
    const where = world();
    const seed = join(where.root, 'seed');
    writeFileSync(join(seed, 'hello.txt'), 'hello\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Greeting');
    git(seed, 'push', '-q', where.origin, 'HEAD:agentgraph/7');
    const first = services(where, [
      [start('a'), wrote('pending.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
    ]);
    const parked = await first.run(
      runWorkflow(flow, { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), tries }, small)
    );
    const from = git(where.origin, 'rev-parse', 'main');
    git(seed, 'checkout', '-q', '--detach', from);
    writeFileSync(join(seed, 'other.txt'), 'upstream\n');
    git(seed, 'add', '-A');
    git(seed, 'commit', '-qm', 'Base moved');
    git(seed, 'push', '-q', where.origin, 'HEAD:main');
    const onto = git(seed, 'rev-parse', 'HEAD');
    await first.run(
      Effect.scoped(
        Effect.gen(function* () {
          const sandbox = yield* Sandbox;
          const tracker = yield* Tracker;
          const work = yield* sandbox.checkout('main', 'agentgraph/7');
          expect(yield* tracker.apply(7, { kind: 'rebase', branch: 'agentgraph/7', from, onto }, work)).toMatchObject({
            ok: true,
          });
        })
      )
    );
    const tip = git(where.origin, 'rev-parse', 'agentgraph/7');
    const next = services(where, [[start('a'), reply(push, pull)]], undefined, spec => {
      expect(readFileSync(join(spec.dir, 'other.txt'), 'utf8')).toBe('upstream\n');
      expect(readFileSync(join(spec.dir, 'pending.txt'), 'utf8')).toBe('pending\n');
    });
    const done = await next.run(driveStored(flow, { ...parked, status: 'running', onto: { sha: onto } }, small));
    expect(done.status).toBe('done');
    expect(next.specs).toHaveLength(1);
    const pushes = readTrace(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'push' ? [t.applied.ok] : []
    );
    expect(pushes).toEqual([true]);
    expect(git(where.origin, 'show', 'agentgraph/7:pending.txt')).toBe('pending');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    expect(readTrace(where.data, 'run-7')).toContainEqual(
      expect.objectContaining({
        applied: expect.objectContaining({
          proposal: expect.objectContaining({ kind: 'rebase', onto: tip }),
          ok: true,
        }),
      })
    );
  });

  it.each(['main', 'agentgraph/8'])('refuses proposals for another branch: %s', async branch => {
    const where = world();
    git(join(where.root, 'seed'), 'push', '-q', where.origin, `main:${branch}`);
    const before = git(where.origin, 'rev-parse', branch);
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ ...push, branch }, { ...pull, branch })],
      [start('a'), reply({ kind: 'ask', question: 'Use my own branch?' })],
    ]);
    await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect(git(where.origin, 'rev-parse', branch)).toBe(before);
    expect(
      readTrace(where.data, 'run-7').flatMap(t =>
        'applied' in t && ['push', 'pull_request'].includes(t.applied.proposal.kind) && t.applied.ok ? [t.applied] : []
      )
    ).toEqual([]);
  });

  it('refuses a merge proposal for another run branch', async () => {
    const where = world();
    pullRequest(where);
    writeIssueAt(
      issuePath(where.tracker, 8, 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/8', base: 'main', head: 'foreign' })
    );
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'merge', number: 8, head: 'foreign' })],
      [start('a'), reply({ kind: 'ask', question: 'My own PR?' })],
    ]);
    await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect((await run(Effect.flatMap(Tracker, f => f.issue(8)))).state).toBe('open');
    expect(
      readTrace(where.data, 'run-7').some(t => 'applied' in t && t.applied.ok && t.applied.proposal.kind === 'merge')
    ).toBe(false);
  });

  it('refuses a merge proposal for a pull request that does not exist', async () => {
    const where = world();
    pullRequest(where);
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'merge', number: 99, head: 'own' })],
      [start('a'), reply({ kind: 'ask', question: 'Which pull request?' })],
    ]);
    const asked = await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect(asked).toMatchObject({ status: 'waiting', reason: 'Which pull request?' });
    expect(specs[1]!.prompt).toContain("merge #99 is not from this run's branch agentgraph/7");
    expect(readTrace(where.data, 'run-7').some(t => 'applied' in t && t.applied.proposal.kind === 'merge')).toBe(false);
  });

  it('accepts a merge proposal for its own branch', async () => {
    const where = world();
    pullRequest(where);
    writeIssueAt(
      issuePath(where.tracker, 8, 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: 'own' })
    );
    const { run } = services(where, [[start('a'), reply({ kind: 'merge', number: 8, head: 'own' })]]);
    await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect((await run(Effect.flatMap(Tracker, f => f.issue(8)))).state).toBe('merged');
  });

  it.each(['symlink', 'oversize'])('folder tracker refuses unsafe push content: %s', async kind => {
    const where = world();
    const { run } = services(
      where,
      [
        [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
        [start('a'), reply({ kind: 'ask', question: 'Cannot publish?' })],
      ],
      undefined,
      spec => {
        if (kind === 'symlink') {
          rmSync(join(spec.dir, 'link.txt'), { force: true });
          symlinkSync('README.md', join(spec.dir, 'link.txt'));
        } else writeFileSync(join(spec.dir, 'big.txt'), 'x'.repeat((1 << 20) + 1));
      }
    );
    await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect(git(where.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentgraph/7')).toBe('');
  });

  it.each(['error', 'cap', 'nonzero'])('does not publish a proposal from an unsuccessful session: %s', async kind => {
    const where = world();
    const complete = reply(push, pull);
    const ended: SessionEvent = {
      type: 'end',
      final: complete.type === 'end' ? complete.final : '',
      ended: kind === 'error' ? 'error' : kind === 'cap' ? 'cap' : 'stop',
      exit: kind === 'nonzero' ? 2 : 0,
    };
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), ended],
      [start('a'), reply({ kind: 'ask', question: 'Try later?' })],
    ]);
    const done = await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect(git(where.origin, 'for-each-ref', '--format=%(refname)', 'refs/heads/agentgraph/7')).toBe('');
    expect(done).toMatchObject({ status: 'waiting', reason: 'Try later?', tries: 0 });
    expect(specs).toHaveLength(2);
  });

  it('reopens a moved branch before retrying without spending a step try', async () => {
    const where = world();
    const seed = join(where.root, 'seed');
    git(seed, 'push', '-q', where.origin, 'main:agentgraph/7');
    let opened = 0;
    let replayed = false;
    const { specs, run } = services(
      where,
      [
        [start('a'), wrote('hello.txt', 'pending\n'), reply(push, pull)],
        [start('a'), reply(push, pull)],
      ],
      undefined,
      spec => {
        if (++opened === 1) {
          writeFileSync(join(seed, 'other.txt'), 'human\n');
          git(seed, 'add', '-A');
          git(seed, 'commit', '-qm', 'Human push');
          git(seed, 'push', '-q', where.origin, 'HEAD:agentgraph/7');
        } else
          replayed =
            existsSync(join(spec.dir, 'other.txt')) &&
            readFileSync(join(spec.dir, 'hello.txt'), 'utf8') === 'pending\n';
      }
    );
    const done = await run(runWorkflow(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect(replayed).toBe(true);
    expect(done).toMatchObject({ status: 'done', tries: 0 });
    expect(specs).toHaveLength(2);
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('human');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('pending');
  });
});
