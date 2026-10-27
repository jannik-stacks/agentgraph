import {
  appendFileSync,
  existsSync,
  mkdirSync,
  readdirSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs';
import { join } from 'node:path';
import { Deferred, Effect, Layer } from 'effect';
import { describe, expect, it } from 'vitest';
import { drive, tick } from '../src/engine.ts';
import { fileForge, Forge, ForgeError } from '../src/forge.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox, type Command } from '../src/sandbox.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { begin, transition } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';
import { world, push, pull, services, readTrace, bodies, driveStored, fresh, pullRequest } from './world.ts';

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
        drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
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

  it('walks again from the branch tip when the forge refuses a push as moved, whatever its reason says', async () => {
    const where = world();
    let refused = false;
    const forge = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
          p.kind === 'push' && !refused
            ? Effect.sync(() => ((refused = true), { proposal: p, ok: false, moved: true as const, reason: 'gone' }))
            : f.apply(n, p, work),
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const layer = Layer.mergeAll(
      forge,
      fileStore(where.data),
      hostSandbox(where.origin),
      replaySession([
        [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
        [start('a'), reply(push, pull)],
      ])
    );
    const done = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
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
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small)
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
      drive(flow, { ...begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), tries }, small)
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
          const forge = yield* Forge;
          const work = yield* sandbox.checkout('main', 'agentgraph/7');
          expect(yield* forge.apply(7, { kind: 'rebase', branch: 'agentgraph/7', from, onto }, work)).toMatchObject({
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
    await run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
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
    writeFileSync(
      join(where.forge, '8', 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/8', base: 'main', head: 'foreign' })
    );
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply({ kind: 'merge', number: 8, head: 'foreign' })],
      [start('a'), reply({ kind: 'ask', question: 'My own PR?' })],
    ]);
    await run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect((await run(Effect.flatMap(Forge, f => f.issue(8)))).state).toBe('open');
    expect(
      readTrace(where.data, 'run-7').some(t => 'applied' in t && t.applied.ok && t.applied.proposal.kind === 'merge')
    ).toBe(false);
  });

  it.each(['agentgraph/7', 'bothub/7'])('accepts a merge proposal for its own branch: %s', async branch => {
    const where = world();
    pullRequest(where);
    writeFileSync(join(where.forge, '8', 'pull.json'), JSON.stringify({ branch, base: 'main', head: 'own' }));
    const { run } = services(where, [[start('a'), reply({ kind: 'merge', number: 8, head: 'own' })]]);
    await run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect((await run(Effect.flatMap(Forge, f => f.issue(8)))).state).toBe('merged');
  });

  it.each(['workflow', 'symlink', 'oversize'])('file forge refuses unsafe push content: %s', async kind => {
    const where = world();
    const { run } = services(
      where,
      [
        [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
        [start('a'), reply({ kind: 'ask', question: 'Cannot publish?' })],
      ],
      undefined,
      spec => {
        if (kind === 'workflow') {
          mkdirSync(join(spec.dir, '.github', 'workflows'), { recursive: true });
          writeFileSync(join(spec.dir, '.github', 'workflows', 'x.yml'), 'run: bad\n');
        } else if (kind === 'symlink') {
          rmSync(join(spec.dir, 'link.txt'), { force: true });
          symlinkSync('README.md', join(spec.dir, 'link.txt'));
        } else writeFileSync(join(spec.dir, 'big.txt'), 'x'.repeat((1 << 20) + 1));
      }
    );
    await run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
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
    const done = await run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
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
    const done = await run(drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small));
    expect(replayed).toBe(true);
    expect(done).toMatchObject({ status: 'done', tries: 0 });
    expect(specs).toHaveLength(2);
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('human');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('pending');
  });

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
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          if (p.kind === 'comment' && p.body === 'Second' && fail) {
            fail = false;
            return Effect.fail(new ForgeError({ message: 'connection failed' }));
          }
          return f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
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
        const parked = yield* drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), kit);
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
        return [done, yield* Effect.flatMap(Forge, f => f.issue(7))] as const;
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
        const asked = yield* drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        yield* driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'This one' }), small);
        return yield* Effect.flatMap(Forge, f => f.issue(7));
      })
    );
    expect(bodies(issue).filter(body => body.split('\n\n')[0] === 'Which?')).toHaveLength(2);
  });

  it('reuses a created child after a later child proposal fails', async () => {
    const where = world();
    let fail = true;
    const failing = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          if (p.kind === 'issue' && p.title === 'Second part' && fail) {
            fail = false;
            return Effect.fail(new ForgeError({ message: 'connection failed' }));
          }
          return f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
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
        const parked = yield* drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small);
        const done = yield* driveStored(flow, transition(flow, parked, { kind: 'answer', text: 'Retry' }), small);
        return [done, yield* Effect.flatMap(Forge, f => f.issues())] as const;
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
      fileForge(where.forge),
      fileStore(where.data),
      sandbox,
      replaySession([[start('a'), wrote('hello.txt', 'hi'), reply(push, pull)]])
    );
    const done = await Effect.runPromise(
      drive(checked, begin(checked, { id: 'run-7', issue: 7, started: fresh().started }), kit).pipe(
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
    const done = await run(drive(flow, current, small));
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
    await expect(run(drive(flow, current, small))).rejects.toThrow();
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
    const done = await run(drive(flow, current, small));
    expect(done.status).toBe('done');
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume).toBeUndefined();
    expect(specs[1]!.prompt).toContain('Use blue');
    expect(specs[1]!.prompt).toContain('types');
  });

  it('returns a refused push to the agent without posting its replies or other writes', async () => {
    const where = world();
    const attempted: Proposal[] = [];
    const failing = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          attempted.push(p);
          return p.kind === 'push'
            ? Effect.succeed({ proposal: p, ok: false, reason: 'branch moved' })
            : f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const skipped: Proposal[] = [
      { kind: 'comment', body: 'Fixed', under: 'review-1' },
      { kind: 'comment', body: 'Changes landed' },
      { kind: 'label', add: ['done'] },
      { kind: 'issue', title: 'Follow up', body: '## Done when\nDetails', relation: 'follow-up' } as Proposal,
    ];
    const session = replaySession([
      [start('a'), wrote('hello.txt', 'hello\n'), reply(...skipped, push, pull)],
      [start('a'), reply({ kind: 'ask', question: 'Retry later' })],
    ]);
    const layer = Layer.mergeAll(failing, fileStore(where.data), hostSandbox(where.origin), session);
    const done = await Effect.runPromise(
      drive(flow, begin(flow, { id: 'run-7', issue: 7, started: fresh().started }), small).pipe(Effect.provide(layer))
    );
    expect(done).toMatchObject({ status: 'waiting', reason: 'Retry later' });
    expect(attempted.some(p => skipped.some(s => JSON.stringify(s) === JSON.stringify(p)))).toBe(false);
    const failed = readTrace(where.data, 'run-7').flatMap(t =>
      'outcome' in t && t.outcome.kind === 'failed' ? [t.outcome] : []
    );
    expect(failed[0]!.proposals.map(a => a.proposal)).toEqual([push, ...skipped.slice(0, 3), pull, skipped[3]]);
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8')).not.toContain('Changes landed');
  });
});
