import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { Effect, Layer, Stream, TestClock, TestContext } from 'effect';
import { describe, expect, it } from 'vitest';
import { drive, runStepChecks, scanIssuesAndRunningRuns, tick } from '../src/engine.ts';
import { fileForge, Forge } from '../src/forge.ts';
import type { Event } from '../src/event.ts';
import type { Proposal } from '../src/proposal.ts';
import type { Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { Trace, SessionEvent, SessionSpec } from '../src/trace.ts';
import { begin, cancelled, transition, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { hubOf, reply, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';
import {
  foot,
  replyHint,
  world,
  push,
  services,
  traceOf,
  reactions,
  bodies,
  driveStored,
  fresh,
  say,
  comment,
  check,
  pullRequest,
} from './world.ts';

describe('stacks', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const issue = small.workflows.issue!;
  const merging = {
    ...small,
    stacks: true,
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
  const flow = merging.workflows.issue;
  const run9 = () => begin(flow, { id: 'run-9', issue: 9, started: '2026-10-16T00:00:01.000Z' });
  const child = (content = 'bye\n', file = 'bye.txt') => [
    start('a'),
    wrote(file, content),
    reply(
      { kind: 'push', branch: 'agentgraph/9', message: 'Add bye' },
      { kind: 'pull_request', branch: 'agentgraph/9', base: 'main', title: 'Add bye', body: 'Stacks on #7. Closes #9' }
    ),
  ];

  /** Pull request #8 on agentgraph/7 with hello.txt, issue #9 that stacks on #7, and `move` to push to agentgraph/7 again. */
  const parent = (where: ReturnType<typeof world>) => {
    const clone = join(where.root, 'clone');
    git(where.root, 'clone', '-q', where.origin, clone);
    git(clone, 'checkout', '-q', '-b', 'agentgraph/7');
    const move = (file: string, content: string) => {
      writeFileSync(join(clone, file), content);
      git(clone, 'add', '-A');
      git(clone, 'commit', '-q', '-m', `Write ${file}`);
      git(clone, 'push', '-q', 'origin', 'agentgraph/7');
      const head = git(clone, 'rev-parse', 'HEAD');
      writeFileSync(
        join(where.forge, '8', 'pull.json'),
        JSON.stringify({ branch: 'agentgraph/7', base: 'main', head })
      );
      return head;
    };
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
    );
    mkdirSync(join(where.forge, '8'), { recursive: true });
    const head = move('hello.txt', 'hello\n');
    writeFileSync(
      join(where.forge, '9.md'),
      '---\ntitle: Say bye\nstate: open\nauthor: morgan\n---\n\nAdd bye.txt.\n\nStacks on #7\n'
    );
    return { head, move };
  };
  const pr10 = (where: ReturnType<typeof world>) => ({
    pull: JSON.parse(readFileSync(join(where.forge, '10', 'pull.json'), 'utf8')),
    body: readFileSync(join(where.forge, '10.md'), 'utf8'),
    diff: readFileSync(join(where.forge, '10', 'diff.patch'), 'utf8'),
  });
  const saved = (where: ReturnType<typeof world>) =>
    JSON.parse(readFileSync(join(where.data, 'run-9', 'run.json'), 'utf8')) as Run;

  it('opens the pull request of an issue that stacks on #7 on its branch, with only its own change', async () => {
    const where = world();
    const { head } = parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(drive(flow, run9(), merging));
    expect(parked).toMatchObject({
      step: 'merge',
      status: 'waiting',
      base: { pull: 8, branch: 'agentgraph/7', sha: head },
    });
    expect(specs[0]!.prompt).toContain('pull requests go into agentgraph/7.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'agentgraph/9', base: 'agentgraph/7' });
    expect(pr.body).toMatch(/\n\nCloses #9\n\nStacks on #8\n?$/);
    expect(pr.diff).toContain('bye.txt');
    expect(pr.diff).not.toContain('hello.txt');
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(head);
  });

  it('with stacks off, opens the same issue as an independent pull request off main', async () => {
    const where = world();
    parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(drive(flow, run9(), { ...merging, stacks: false }));
    expect(parked.base).toBeUndefined();
    expect(specs[0]!.prompt).toContain('pull requests go into main.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'agentgraph/9', base: 'main' });
    expect(pr.body).not.toContain('Stacks on');
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(git(where.origin, 'rev-parse', 'main'));
  });

  it('keeps saved edits while a stacked branch follows its parent', async () => {
    const where = world();
    const { move } = parent(where);
    const first = services(where, [
      child(),
      [start('a'), wrote('pending.txt', 'pending\n'), reply({ kind: 'ask', question: 'Continue?' })],
    ]);
    const parked = await first.run(
      Effect.gen(function* () {
        const waiting = yield* drive(flow, run9(), merging);
        return yield* driveStored(flow, { ...waiting, step: 'implement', status: 'running' }, merging);
      })
    );
    expect(git(where.origin, 'show', 'refs/agentgraph/runs/run-9:pending.txt')).toBe('pending');
    move('more.txt', 'more\n');
    const next = services(where, [
      [start('a'), reply({ kind: 'push', branch: 'agentgraph/9', message: 'Pending work' })],
    ]);
    await next.run(tick(merging, 9));
    expect(git(where.origin, 'show', 'refs/agentgraph/runs/run-9:pending.txt')).toBe('pending');
    await next.run(driveStored(flow, { ...parked, status: 'running' }, merging));
    expect(git(where.origin, 'show', 'agentgraph/9:pending.txt')).toBe('pending');
    expect(git(where.origin, 'show', 'agentgraph/9:more.txt')).toBe('more');
  });

  it('rebases the branch onto the new head when #8 moves, keeping its own commit on top', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child()]);
    await run(drive(flow, run9(), merging));
    const moved = move('more.txt', 'more\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(moved);
    expect(git(where.origin, 'log', '--format=%s', 'agentgraph/7..agentgraph/9')).toBe('Add bye');
    expect(saved(where)).toMatchObject({ status: 'waiting', base: { sha: moved } });
    const pr = pr10(where);
    expect(pr.pull.head).toBe(git(where.origin, 'rev-parse', 'agentgraph/9'));
    expect(pr.diff).not.toContain('more.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
  });

  it('retries a refused stack follow from its last successful base', async () => {
    const where = world();
    const { move } = parent(where);
    let refused = true;
    const forge = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          if (p.kind === 'rebase' && !p.head && refused) {
            refused = false;
            return Effect.succeed({ proposal: p, ok: false, reason: 'temporary ref refusal' });
          }
          return f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const layer = Layer.mergeAll(forge, fileStore(where.data), hostSandbox(where.origin), replaySession([child()]));
    const run = <A, E>(effect: Effect.Effect<A, E, Forge | Store | Sandbox | Session>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)));
    await run(drive(flow, run9(), merging));
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    const moved = move('more.txt', 'more\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9^')).toBe(moved);
    expect(readFileSync(join(where.forge, '9.jsonl'), 'utf8').split('could not follow')).toHaveLength(2);
  });

  it('says on the issue when the branch does not rebase cleanly and leaves it where it was', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child('hello and bye\n', 'hello.txt')]);
    await run(drive(flow, run9(), merging));
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    const moved = move('hello.txt', 'hi\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
    expect(readFileSync(join(where.forge, '9.jsonl'), 'utf8')).toContain('#8 moved and agentgraph/9 could not follow');
    expect(saved(where).base?.sha).toBe(moved);
  });
});

describe('coworker', () => {
  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const flow = small.workflows.issue!;
  const begun = () => begin(flow, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' });

  it('prompts a fresh session with the issue, its pull request and its checks', async () => {
    const where = world();
    pullRequest(where);
    say(where, comment(8, 'ana', true, 'mind the edge case', '2026-10-16T00:00:02.000Z'));
    say(where, check(8, 'test', 'failure', '2026-10-16T00:00:03.000Z'));
    const { specs, run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push)]]);
    await run(drive(flow, begun(), small));
    expect(specs[0]!.prompt).toContain('## Pull request #8 Add hello');
    expect(specs[0]!.prompt).toContain('#7 @morgan: /agent');
    expect(specs[0]!.prompt).toContain('#8 @ana: mind the edge case');
    expect(specs[0]!.prompt).toContain('#8 check test: failure');
    expect(specs[0]!.prompt).not.toContain('holds what is new');
    expect(specs[0]!.read).toBeUndefined();
  });

  /** Run 7 parked on a question in its kept implement session, with pull request #8 on base b1. */
  const parked = async (where: ReturnType<typeof world>, turns: SessionEvent[][]) => {
    pullRequest(where);
    const s = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })], ...turns]);
    const asked = await s.run(drive(flow, begun(), small));
    expect(asked).toMatchObject({ status: 'waiting', sessions: { implement: { id: 'a' } } });
    return { ...s, asked };
  };
  const later = (s: number) => `2099-01-01T00:00:0${s}.000Z`;

  it('catches a resumed session up on what people said and pushed while it was parked, and nothing older', async () => {
    const where = world();
    const { specs, run, asked } = await parked(where, [[start('a'), reply({ kind: 'comment', body: 'ok' })]]);
    say(where, comment(7, 'morgan', true, '/agent hello', later(1)));
    say(where, {
      issue: 8,
      kind: 'commit',
      actor: 'ana',
      trusted: false,
      at: later(2),
      commit: { sha: 'abcdef123', title: 'Tweak the greeting' },
    });
    await run(driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small));
    expect(specs[1]!.resume?.id).toBe('a');
    expect(specs[1]!.prompt).toBe(
      'hello\n\n## New since you last looked\n\n#7 @morgan: /agent hello\n\n#8 @ana pushed abcdef1 Tweak the greeting'
    );
  });

  it('resumes with only the feedback when nothing is new, and names a moved base and a flipped check', async () => {
    const where = world();
    say(where, check(8, 'test', 'failure', '2026-10-16T00:00:00.500Z'));
    const { specs, run, asked } = await parked(where, [
      [start('a'), reply({ kind: 'ask', question: 'And now?' })],
      [start('a'), reply({ kind: 'comment', body: 'ok' })],
    ]);
    const again = await run(driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small));
    expect(specs[1]!.prompt).toBe('hello');
    pullRequest(where, 'b2');
    say(where, check(8, 'test', 'success', later(3)));
    await run(driveStored(flow, transition(flow, again, { kind: 'answer', text: 'go on' }), small));
    expect(specs[2]!.prompt).toBe(
      'go on\n\n## New since you last looked\n\nThe base main moved to b2.\n\n#8 check test: success'
    );
  });

  it('refreshes the news file outside the checkout every minute, keeps it on a failed refresh, and never writes through links in the checkout', async () => {
    const where = world();
    const seen: string[] = [];
    const wait = (ms: number) => Effect.promise(() => new Promise(r => setTimeout(r, ms)));
    let file = '';
    const news = (_dir: string) => readFileSync(file, 'utf8');
    const target = join(where.forge, 'victim.txt');
    writeFileSync(target, 'keep\n');
    const minute = (dir: string, until: (text: string) => boolean) =>
      Effect.gen(function* () {
        yield* wait(50);
        yield* TestClock.adjust('1 minute');
        for (let i = 0; i < 40 && !until(news(dir)); i++) yield* wait(25);
        seen.push(news(dir));
      });
    const session = Layer.succeed(Session, {
      open: (spec: SessionSpec) =>
        Stream.fromEffect(
          Effect.gen(function* () {
            file = /(\S+) holds what is new/.exec(spec.prompt)![1]!;
            expect(file.startsWith(spec.dir)).toBe(false);
            expect(spec.read).toEqual([dirname(file)]);
            mkdirSync(join(spec.dir, '.agentgraph'));
            symlinkSync(target, join(spec.dir, '.agentgraph', 'news.md'));
            symlinkSync(where.forge, join(spec.dir, 'news'));
            seen.push(news(spec.dir));
            say(where, comment(7, 'ana', true, 'also say bye', later(1)));
            yield* minute(spec.dir, text => text.includes('also say bye'));
            renameSync(join(where.forge, '7.md'), join(where.forge, '7.away'));
            say(where, comment(7, 'ana', true, 'never seen', later(2)));
            yield* minute(spec.dir, () => false);
            renameSync(join(where.forge, '7.away'), join(where.forge, '7.md'));
            writeFileSync(join(spec.dir, 'hello.txt'), 'hello\n');
            rmSync(join(spec.dir, '.agentgraph'), { recursive: true });
            rmSync(join(spec.dir, 'news'));
          })
        ).pipe(Stream.flatMap(() => Stream.fromIterable([start('a'), reply(push)]))),
    });
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), hostSandbox(where.origin), session);
    const agents = Object.fromEntries(Object.entries(small.agents).map(([k, a]) => [k, { ...a, tools: ['read'] }]));
    const done = await Effect.runPromise(
      drive({ ...flow, concurrency: 'queue' }, begun(), { ...small, agents }).pipe(
        Effect.provide(layer),
        Effect.provide(TestContext.TestContext)
      )
    );
    expect(done.status).toBe('done');
    expect(seen).toEqual([
      'Nothing new yet.\n',
      '## New since you last looked\n\n@ana: also say bye\n',
      '## New since you last looked\n\n@ana: also say bye\n',
    ]);
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(git(where.origin, 'ls-tree', '-r', '--name-only', 'agentgraph/7')).not.toContain('.agentgraph');
    expect(readFileSync(target, 'utf8')).toBe('keep\n');
  });

  /**
   * The doubles, where the first session says `m` on the forge while it works. With `cut`, it then lets a minute pass and
   * works until it is cut short; else it plays the first turn.
   */
  const during = (where: ReturnType<typeof world>, m: Event, turns: SessionEvent[][], cut = false) => {
    const specs: SessionSpec[] = [];
    const session = Layer.effect(
      Session,
      Effect.map(Session, s => ({
        open: (spec: SessionSpec) => {
          if (specs.push(spec) > 1) return s.open(spec);
          const said = Stream.execute(Effect.sync(() => say(where, m)));
          if (!cut) return Stream.concat(said, s.open(spec));
          const minute = Effect.gen(function* () {
            yield* Effect.promise(() => new Promise(r => setTimeout(r, 50)));
            yield* TestClock.adjust('1 minute');
            return yield* Effect.never;
          });
          return Stream.make(start('a')).pipe(Stream.concat(said), Stream.concat(Stream.execute(minute)));
        },
      }))
    ).pipe(Layer.provide(replaySession(turns)));
    const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), hostSandbox(where.origin), session);
    const go = (w: typeof flow) =>
      Effect.runPromise(drive(w, begun(), small).pipe(Effect.provide(layer), Effect.provide(TestContext.TestContext)));
    return { specs, go };
  };
  const bye = comment(7, 'ana', true, '/agent say bye too', later(1));
  const greet = [start('a'), wrote('hello.txt', 'hello\n'), reply(push)];

  it('steer: a comment made while the session works reaches it in one more turn of the same session', async () => {
    const where = world();
    const { specs, go } = during(where, bye, [greet, [start('a'), reply(push)]]);
    const done = await go(flow);
    expect(done).toMatchObject({ status: 'done', seen: later(1) });
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume?.id).toBe('a');
    expect(specs[1]!.prompt).toContain('@ana: /agent say bye too');
    expect(specs[1]!.prompt).toContain('end your reply with the whole agentgraph block again');
  });

  it('queue: a comment made while the session works applies once the try ends, as an answer would', async () => {
    const where = world();
    const asks = [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })];
    const { specs, go } = during(where, bye, [asks, greet]);
    const done = await go({ ...flow, concurrency: 'queue' });
    expect(done).toMatchObject({ status: 'done', answers: [{ asked: 'Hello or hi?', said: 'say bye too' }] });
    expect(specs).toHaveLength(2);
    expect(specs[1]!.prompt.startsWith('say bye too')).toBe(true);
  });

  it('cancel: a comment cuts the session short and the step starts again at once with it, in the same session', async () => {
    const where = world();
    const { specs, go } = during(where, bye, [greet], true);
    const done = await go({ ...flow, concurrency: 'cancel' });
    expect(done).toMatchObject({ status: 'done', tries: 0, seen: later(1) });
    expect(specs).toHaveLength(2);
    expect(specs[1]!.resume?.id).toBe('a');
    expect(specs[1]!.prompt.startsWith('say bye too')).toBe(true);
    const ends = traceOf(where.data, done.id).flatMap(t => ('session' in t ? [t.session.ended] : []));
    expect(ends[0]).toBe('human');
  });

  it('cancel parks a working run with its session, and stop ends it, whatever the concurrency', async () => {
    const parked = await during(world(), comment(7, 'ana', true, '/agent cancel', later(1)), [], true).go(flow);
    expect(parked).toMatchObject({ status: 'waiting', reason: cancelled, sessions: { implement: { id: 'a' } } });
    const stop = comment(7, 'ana', true, '/agent stop wrong issue', later(1));
    const stopped = await during(world(), stop, [], true).go({ ...flow, concurrency: 'queue' });
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'wrong issue' });
  });

  const assigned = { ...small, workflows: { issue: { ...flow, on: { issues: { label: 'agentgraph' } } } } };
  const labelled = (actor: string, trusted: boolean, kind: 'label' | 'unlabel', at: string): Event => ({
    issue: 7,
    kind,
    actor,
    trusted,
    at,
    label: 'agentgraph',
  });

  it("begins a run on a maintainer's agentgraph label, not on an outsider's, and stops it when the label is removed", async () => {
    const where = world();
    say(where, labelled('mallory', false, 'label', '2026-10-16T00:00:01.000Z'));
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(tick(assigned))).toEqual([]);
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:02.000Z'));
    const [asked] = await run(tick(assigned));
    expect(asked).toMatchObject({ issue: 7, status: 'waiting' });
    expect(specs).toHaveLength(1);
    say(where, labelled('mallory', false, 'unlabel', later(1)));
    expect(await run(tick(assigned))).toEqual([]);
    say(where, labelled('morgan', true, 'unlabel', later(2)));
    const [stopped] = await run(tick(assigned));
    expect(stopped).toMatchObject({ id: asked!.id, status: 'stopped', reason: 'the agentgraph label was removed' });
    expect(readFileSync(join(where.forge, '7.reactions'), 'utf8')).toBe('');
    expect(reactions(where.data, asked!.id)).toEqual([
      [true, undefined],
      [true, '#7'],
    ]);
    expect((await run(Effect.flatMap(Forge, f => f.issue(7)))).labels).toEqual(['agentgraph:stopped']);
  });

  it('begins on one issue only where the latest agentgraph label came from a maintainer', async () => {
    const where = world();
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:01.000Z'));
    say(where, labelled('mallory', false, 'unlabel', '2026-10-16T00:00:02.000Z'));
    say(where, labelled('mallory', false, 'label', '2026-10-16T00:00:03.000Z'));
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(tick(assigned, 7, true))).toEqual([]);
    say(where, labelled('morgan', true, 'label', '2026-10-16T00:00:04.000Z'));
    expect((await run(tick(assigned, 7, true))).map(r => r.status)).toEqual(['waiting']);
  });

  const ready = {
    ...small,
    workflows: { issue: { ...flow, on: { issue_comment: {}, issues: { label: 'agent:ready' } } } },
  };
  const marked = (actor: string, trusted: boolean, at: string): Event => ({
    issue: 7,
    kind: 'label',
    actor,
    trusted,
    at,
    label: 'agent:ready',
  });

  it("starts a mention workflow on a maintainer's agent:ready, never on a bot's or an outsider's, and once per issue", async () => {
    const where = world();
    writeFileSync(join(where.forge, '7.jsonl'), '');
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect(await run(scanIssuesAndRunningRuns(ready))).toEqual([]);
    say(where, marked('stx-agentgraph[bot]', false, '2026-10-16T00:00:01.000Z'));
    say(where, marked('mallory', false, '2026-10-16T00:00:02.000Z'));
    expect(await run(scanIssuesAndRunningRuns(ready))).toEqual([]);
    say(where, marked('morgan', true, '2026-10-16T00:00:03.000Z'));
    const [asked] = await run(scanIssuesAndRunningRuns(ready));
    expect(asked).toMatchObject({ issue: 7, workflow: 'issue', status: 'waiting' });
    expect(specs).toHaveLength(1);
    await run(Effect.flatMap(Store, s => s.put({ ...asked!, status: 'done' })));
    say(where, { ...marked('morgan', true, later(1)), kind: 'unlabel' });
    say(where, marked('morgan', true, later(2)));
    expect(await run(scanIssuesAndRunningRuns(ready))).toEqual([]);
    expect(specs).toHaveLength(1);
  });

  it('still starts a mention workflow on /agent when it also starts on a label', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    expect((await run(scanIssuesAndRunningRuns(ready))).map(r => [r.issue, r.status])).toEqual([[7, 'waiting']]);
  });

  it('keeps one status comment through two tries and an ask, with the question in its own comment', async () => {
    const where = world();
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'TODO\n'), reply(push)],
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
    ]);
    const asked = await run(drive(flow, begun(), small));
    expect(asked).toMatchObject({ status: 'waiting', tries: 1, comment: '7-3' });
    const issue = await run(Effect.flatMap(Forge, f => f.issue(7)));
    expect(issue.labels).toEqual(['agentgraph:waiting']);
    expect(bodies(issue)).toEqual([
      '/agent',
      `Waiting for an answer to the question below, at implement.\n\n${foot(replyHint)}`,
      'Hello or hi?',
    ]);
    const edits = traceOf(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'comment' && t.applied.proposal.edit
        ? [t.applied.proposal.body]
        : []
    );
    expect(edits).toEqual([expect.stringMatching(/^Waiting for an answer/)]);
  });

  it.each([false, true])('uses every check retry before asking a human (fixed: %s)', async fixed => {
    const where = world();
    const findings = '{"at":"hello.txt:1","why":"TODO remains"}';
    const checked = {
      ...small,
      checks: {
        ...small.checks,
        types: { ...small.checks.types!, run: `if grep -q TODO hello.txt; then echo '${findings}'; exit 1; fi` },
      },
    };
    const typed = {
      ...flow,
      steps: [{ name: 'implement', does: { agent: 'implementor' }, checks: ['types'], tries: 3 }],
    };
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'TODO\n'), reply(push)],
      [start('a'), reply(push)],
      [start('a'), ...(fixed ? [wrote('hello.txt', 'hello\n')] : []), reply(push)],
    ]);
    const done = await run(drive(typed, begin(typed, { id: 'run-7', issue: 7, started: fresh().started }), checked));
    expect(specs).toHaveLength(3);
    expect(specs[2]!.prompt).toContain(findings);
    expect(done).toMatchObject({ status: fixed ? 'done' : 'waiting', tries: fixed ? 2 : 3 });
    const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
    expect(issue.join('\n')).not.toContain(findings);
    if (!fixed) {
      expect(done.reason).toBe(
        'implement failed after 3 tries (checks: types).\n\ntypes: hello.txt:1: TODO remains\n\nHow should I proceed?'
      );
      expect(issue).toContain(done.reason);
    }
    const outcomes = traceOf(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome.kind] : []));
    expect(outcomes).toEqual(['failed', 'failed', fixed ? 'pass' : 'failed']);
  });

  it('opens a step that can send the change back on the whole diff of the branch', async () => {
    const where = world();
    const reviewed = {
      ...flow,
      steps: [
        { name: 'implement', does: { agent: 'implementor' }, checks: [], tries: 1 },
        { name: 'review', does: { agent: 'reviewer' }, checks: [], tries: 1, back: { to: 'implement', until: 'done' } },
      ],
    };
    const { specs, run } = services(where, [
      [start('a'), wrote('hello.txt', 'hello\n'), reply(push)],
      [start('r'), reply({ kind: 'comment', body: 'Fine.' })],
    ]);
    await run(drive(reviewed, begin(reviewed, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), small));
    expect(specs[0]!.prompt).not.toContain('## The change on the branch');
    expect(specs[1]!.prompt).toMatch(/## The change on the branch\n\n````diff\n[\s\S]*\+hello\n````/);
  });

  it('tells a waiting run how to be answered in its status footer, and posts the question itself plain', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    await run(drive(flow, begun(), small));
    const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
    expect(issue.filter(b => b.includes('Hello or hi?'))).toEqual(['Hello or hi?']);
    expect(issue.filter(b => b.includes(replyHint))).toHaveLength(1);
  });

  it('moves the status below an answered question, so it never sits above a question already answered', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    await run(drive(flow, begun(), small));
    where.human('/agent hi', new Date().toISOString());
    await services(where, [[start('a'), reply({ kind: 'ask', question: 'Hi with a dot?' })]]).run(tick(small, 7));
    expect(bodies(await run(Effect.flatMap(Forge, f => f.issue(7))))).toEqual([
      '/agent',
      'Asked the question below at implement.',
      'Hello or hi?',
      '/agent hi',
      `Waiting for an answer to the question below, at implement.\n\n${foot(replyHint)}`,
      'Hi with a dot?',
    ]);
  });

  it('lets an agent answer a review comment by the id its context shows, on the pull request', async () => {
    const where = world();
    pullRequest(where);
    const at = '2026-10-16T00:00:03.000Z';
    const line = { id: 'r1', author: 'morgan', body: 'why hello?', at, path: 'hello.txt', line: 1 };
    say(where, { ...comment(8, 'morgan', true, 'why hello?', at), comment: line });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Asked for.', under: 'r1' })]]);
    await run(drive(flow, { ...begun(), said: [{ issue: 7 }] }, small));
    expect(specs[0]!.prompt).toContain('@morgan on hello.txt:1, id r1: why hello?');
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under, c.path])).toEqual([
      ['Asked for.', 'r1', 'hello.txt'],
    ]);
  });

  it('replies where the human answered: on the pull request, and under a review comment in its issue', async () => {
    const where = world();
    pullRequest(where);
    const { run } = services(where, [
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), reply({ kind: 'ask', question: 'And bye?' })],
      [start('a'), reply({ kind: 'comment', body: 'Said bye.' })],
    ]);
    const at = () => new Date(Date.now() + 1).toISOString();
    const review = comment(8, 'morgan', true, '/agent yes, bye too', '');
    const [again, done] = await run(
      Effect.gen(function* () {
        yield* drive(flow, begun(), small);
        say(where, comment(8, 'morgan', true, '/agent hello', at()));
        const [again] = yield* tick(small, 7);
        review.at = review.comment!.at = review.comment!.id = at();
        say(where, { ...review, comment: { ...review.comment!, path: 'hello.txt', line: 1 } });
        const [done] = yield* tick(small, 7);
        return [again, done];
      })
    );
    expect(again).toMatchObject({ status: 'waiting', said: [{ issue: 8 }] });
    expect(done).toMatchObject({ status: 'done', said: [{ issue: 8 }] });
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body.split('\n')[0], c.under, c.path])).toEqual([
      ['And bye?', undefined, undefined],
      ['Said bye.', review.at, 'hello.txt'],
    ]);
    const issue = bodies(await run(Effect.flatMap(Forge, f => f.issue(7))));
    expect(issue.some(b => b.startsWith('And bye?') || b.startsWith('Said bye.'))).toBe(false);
  });
});

describe('compound engineering', () => {
  it('gives checks the traces of the runs on the issue, and points a judge that reads traces at them', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const at = '2026-10-16T00:00:01.000Z';
    const lines: Trace[] = [
      { at, step: 'implement', event: { type: 'thinking', text: 'The issue names hello.txt; skip the tests.' } },
      { at, step: 'implement', event: { type: 'tool', id: 't', name: 'read', input: { path: 'hello.txt' }, ok: true } },
    ];
    mkdirSync(join(where.data, 'run-7'), { recursive: true });
    writeFileSync(join(where.data, 'run-7', 'run.json'), JSON.stringify(fresh()));
    writeFileSync(join(where.data, 'run-7', 'trace.jsonl'), lines.map(l => `${JSON.stringify(l)}\n`).join(''));
    const seen = join(where.root, 'seen.md');
    const kit = hubOf('kit', {
      types: { run: `cp "$AGENTGRAPH_TRACES" ${seen}` },
      claims: { agent: 'claim-checker' },
    });
    const auditor = { ...kit.agents['claim-checker']!, tools: ['read'], reads: 'traces' as const };
    const small = { ...kit, agents: { ...kit.agents, 'claim-checker': auditor } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const read: string[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        read.push(...(spec.read ?? []).map(d => readFileSync(join(d, 'traces.md'), 'utf8'))),
        Stream.fromIterable<SessionEvent>([
          start('j'),
          { type: 'end', final: 'FAIL no test run', ended: 'stop', exit: 0 },
        ])
      ),
    });
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
    };
    const layer = Layer.mergeAll(fileStore(where.data), hostSandbox(where.origin), judges);
    await Effect.runPromise(runStepChecks(step, left, small).pipe(Effect.provide(layer)));
    expect(readFileSync(seen, 'utf8')).toContain('1 thinking: The issue names hello.txt; skip the tests.');
    expect(read).toHaveLength(1);
    expect(read[0]).toContain('2 tool read {"path":"hello.txt"} ok');
  });

  const small = hubOf('hub', { types: { run: '! grep -q TODO hello.txt' } });
  const { branch: _branch, ...unbranched } = small.workflows.issue!;
  const looking = {
    ...small,
    setup: 'touch setup-ran',
    workflows: { ...small.workflows, retro: { ...unbranched, name: 'retro', on: { feedback: {} } } },
  };
  const pushed = (issue: number, at: string): Event => ({
    issue,
    kind: 'commit',
    actor: 'morgan',
    trusted: true,
    at,
    commit: { sha: 'abcdef0123', title: 'Document the field' },
  });
  const done = () =>
    Effect.flatMap(Store, s =>
      s.put({ ...begin(small.workflows.issue!, { id: 'run-7', issue: 7, started: fresh().started }), status: 'done' })
    );
  const retros = Effect.map(
    Effect.flatMap(Store, s => s.list({ issue: 7 })),
    runs => runs.filter(r => r.workflow === 'retro')
  );

  it('starts one quiet retro on what people said or pushed where a run worked, and nothing from commands or bots', async () => {
    const where = world();
    say(where, comment(7, 'mallory', false, 'this is wrong', '2026-10-16T00:00:04.000Z'));
    say(where, pushed(7, '2026-10-16T00:00:05.000Z'));
    say(where, comment(7, 'morgan', true, '/agent stop', '2026-10-16T00:00:06.000Z'));
    say(where, {
      ...comment(7, 'morgan', true, 'Fine, but the new field needs docs.', '2026-10-16T00:00:07.000Z'),
      kind: 'approved',
    });
    const { specs, commands, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.status, r.started])).toEqual([
      ['retro', 'done', '2026-10-16T00:00:07.000Z'],
    ]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain(
      '## What a person said or pushed\n\n@morgan pushed abcdef0 Document the field\n\n@morgan approved: Fine, but the new field needs docs.'
    );

    expect(commands.map(c => c.args.join(' ')).join('\n')).not.toContain('setup-ran');
    expect(readFileSync(join(where.forge, '7.jsonl'), 'utf8').trim().split('\n')).toHaveLength(5);
    expect(readFileSync(join(where.forge, '7.md'), 'utf8')).toContain('labels: []');
    expect(await run(tick(looking))).toEqual([]);
    say(where, pushed(7, '2026-10-16T00:00:08.000Z'));
    const again = await run(tick(looking));
    expect(again.map(r => [r.workflow, r.started])).toEqual([['retro', '2026-10-16T00:00:08.000Z']]);
    expect(specs.at(-1)!.prompt).toMatch(
      /## What a person said or pushed\n\n@morgan pushed abcdef0 Document the field\n\n(?!@morgan approved)/
    );
    expect((await run(retros)).map(r => r.workflow)).toEqual(['retro', 'retro']);
  });

  it('a live retro holds neither the issue nor its answers', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Hi.' })]]);
    await run(done());
    const live = begin(looking.workflows.retro, { id: 'retro-7', issue: 7, started: '2026-10-16T00:00:02.000Z' });
    await run(Effect.flatMap(Store, s => s.put({ ...live, status: 'waiting', reason: 'parked' })));
    where.human('/agent once more', '2026-10-16T00:00:05.000Z');
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.started])).toContainEqual(['issue', '2026-10-16T00:00:05.000Z']);
    expect(specs[0]!.agent).toBe('implementor');
    expect((await run(retros)).find(r => r.id === 'retro-7')?.status).toBe('waiting');
  });

  it('starts the next retro while one works, so what is said meanwhile waits on nothing', async () => {
    const where = world();
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const live = begin(looking.workflows.retro, { id: 'retro-7', issue: 7, started: '2026-10-16T00:00:02.000Z' });
    await run(Effect.flatMap(Store, s => s.put({ ...live, status: 'waiting', reason: 'parked' })));
    say(where, pushed(7, '2026-10-16T00:00:04.000Z'));
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.started])).toEqual([['retro', '2026-10-16T00:00:04.000Z']]);
    expect(specs[0]!.prompt).toContain('said or pushed\n\n@morgan pushed abcdef0 Document the field');
  });

  it('takes a stop with a reason as feedback, and a bare stop as a command', async () => {
    const where = world();
    say(where, comment(7, 'morgan', true, '/agent stop', '2026-10-16T00:00:04.000Z'));
    say(where, comment(7, 'morgan', true, '/agent stop you rewrote the whole module', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    expect((await run(tick(looking))).map(r => r.workflow)).toEqual(['retro']);
    expect(specs[0]!.prompt).toContain('said or pushed\n\n@morgan: /agent stop you rewrote the whole module\n');
  });

  it('looks up no open issue a run never worked on', async () => {
    const where = world();
    writeFileSync(join(where.forge, '12.md'), '---\ntitle: Other\nstate: open\nauthor: morgan\n---\n\nElse.\n');
    say(where, comment(12, 'morgan', true, 'Unrelated.', '2026-10-16T00:00:05.000Z'));
    const asked: number[] = [];
    const counted = Layer.effect(
      Forge,
      Effect.map(Forge, f => ({ ...f, issue: (n: number) => (asked.push(n), f.issue(n)) }))
    ).pipe(Layer.provide(fileForge(where.forge)));
    const layer = Layer.mergeAll(counted, fileStore(where.data), hostSandbox(where.origin), replaySession([]));
    const go = <A, E>(e: Effect.Effect<A, E, Forge | Store | Session | Sandbox>) =>
      Effect.runPromise(e.pipe(Effect.provide(layer)));
    await go(done());
    expect(await go(tick(looking))).toEqual([]);
    expect(asked).not.toContain(12);
  });

  it('takes what is said on a merged pull request as feedback on the issue its branch worked on', async () => {
    const where = world();
    writeFileSync(
      join(where.forge, '8.md'),
      '---\ntitle: Add hello\nstate: merged\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
    );
    mkdirSync(join(where.forge, '8'), { recursive: true });
    writeFileSync(
      join(where.forge, '8', 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/7', base: 'main', head: 'x', baseSha: 'b1' })
    );
    say(where, comment(8, 'morgan', true, 'Next time reuse the helper.', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const touched = await run(tick(looking));
    expect(touched.map(r => [r.workflow, r.issue])).toEqual([['retro', 7]]);
    expect(specs[0]!.prompt).toContain('@morgan: Next time reuse the helper.');
  });
});
