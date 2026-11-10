import { mkdirSync, readFileSync, renameSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { TestClock } from 'effect/testing';
import { describe, expect, it } from 'vitest';
import { scanIssuesAndRunningRuns, tick } from '../src/run/trigger.ts';
import { folderTracker, Tracker } from '../src/tracker.ts';
import type { Event } from '../src/event.ts';
import { Sandbox } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin, cancelled, transition } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, start, wrote } from './fixtures.ts';
import { findStatus, git, issuePath, writeIssueAt } from './kit.ts';
import {
  replyHint,
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
  check,
  pullRequest,
} from './world.ts';
import { runWorkflow } from '../src/run/drive.ts';
import { type SessionEvent, type SessionSpec, TrackerError } from '../src/types.ts';

describe('coworker', () => {
  const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
  const flow = small.workflows.issue!;
  const begun = () => begin(flow, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' });

  it('prompts a fresh session with the issue, its pull request and its checks', async () => {
    const where = world();
    pullRequest(where);
    say(where, comment(8, 'ana', true, 'mind the edge case', '2026-10-16T00:00:02.000Z'));
    say(where, check(8, 'test', 'failure', '2026-10-16T00:00:03.000Z'));
    const { specs, run } = services(where, [[start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)]]);
    await run(runWorkflow(flow, begun(), small));
    expect(specs[0]!.prompt).toContain('## Pull request #8 Add hello');
    expect(specs[0]!.prompt).toContain('#7 @morgan: /agent');
    expect(specs[0]!.prompt).toContain('#8 @ana: mind the edge case');
    expect(specs[0]!.prompt).toContain('#8 check test: failure');
    expect(specs[0]!.prompt).toContain('holds what is new');
    expect(specs[0]!.read).toEqual([expect.any(String)]);
    expect(specs[0]!.prompt).toContain(specs[0]!.read![0]!);
  });

  /** Run 7 parked on a question in its kept implement session, with pull request #8 on base b1. */
  const parked = async (where: ReturnType<typeof world>, turns: SessionEvent[][]) => {
    pullRequest(where);
    const s = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })], ...turns]);
    const asked = await s.run(runWorkflow(flow, begun(), small));
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
    expect(specs[1]!.prompt.split('\n\nPeople may comment')[0]).toBe(
      'hello\n\n## New since you last looked\n\n#7 @morgan: /agent hello\n\n#8 @ana pushed abcdef1 Tweak the greeting'
    );
  });

  it('names the news file inside the sandbox to a resumed session', async () => {
    const where = world();
    const { specs, run, asked } = await parked(where, [[start('a'), reply({ kind: 'comment', body: 'ok' })]]);
    await run(driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small));
    expect(specs[1]!.prompt).toContain('/news/news.md holds what is new');
    expect(specs[1]!.read).toEqual(['/news']);
  });

  it('resumes with only the feedback when nothing is new, and names a moved base and a flipped check', async () => {
    const where = world();
    say(where, check(8, 'test', 'failure', '2026-10-16T00:00:00.500Z'));
    const { specs, run, asked } = await parked(where, [
      [start('a'), reply({ kind: 'ask', question: 'And now?' })],
      [start('a'), reply({ kind: 'comment', body: 'ok' })],
    ]);
    const again = await run(driveStored(flow, transition(flow, asked, { kind: 'answer', text: 'hello' }), small));
    expect(specs[1]!.prompt.split('\n\nPeople may comment')[0]).toBe('hello');
    pullRequest(where, 'b2');
    say(where, check(8, 'test', 'success', later(3)));
    await run(driveStored(flow, transition(flow, again, { kind: 'answer', text: 'go on' }), small));
    expect(specs[2]!.prompt.split('\n\nPeople may comment')[0]).toBe(
      'go on\n\n## New since you last looked\n\nThe base main moved to b2.\n\n#8 check test: success'
    );
  });

  it('refreshes the news file outside the checkout every minute, keeps it on a failed refresh, and never writes through links in the checkout', async () => {
    const where = world();
    const seen: string[] = [];
    const wait = (ms: number) => Effect.promise(() => new Promise(r => setTimeout(r, ms)));
    let file = '';
    const news = (_dir: string) => readFileSync(file, 'utf8');
    const target = join(where.tracker, 'victim.txt');
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
            expect(/(\S+) holds what is new/.exec(spec.prompt)![1]).toBe('/news/news.md');
            expect(spec.read).toEqual(['/news']);
            expect(file.startsWith(spec.dir)).toBe(false);
            mkdirSync(join(spec.dir, '.agentgraph'));
            symlinkSync(target, join(spec.dir, '.agentgraph', 'news.md'));
            symlinkSync(where.tracker, join(spec.dir, 'news'));
            seen.push(news(spec.dir));
            say(where, comment(7, 'ana', true, 'also say bye', later(1)));
            yield* minute(spec.dir, text => text.includes('also say bye'));
            renameSync(issuePath(where.tracker, 7), join(where.tracker, '7.away'));
            say(where, comment(7, 'ana', true, 'never seen', later(2)));
            yield* minute(spec.dir, () => false);
            renameSync(join(where.tracker, '7.away'), issuePath(where.tracker, 7));
            writeFileSync(join(spec.dir, 'hello.txt'), 'hello\n');
            rmSync(join(spec.dir, '.agentgraph'), { recursive: true });
            rmSync(join(spec.dir, 'news'));
          })
        ).pipe(Stream.flatMap(() => Stream.fromIterable([start('a'), reply(push, pull)]))),
    });
    const layer = Layer.mergeAll(
      folderTracker(where.tracker),
      fileStore(where.data),
      Layer.effect(
        Sandbox,
        Effect.map(Sandbox, s => ({
          ...s,
          checkout: (...args: Parameters<typeof s.checkout>) =>
            s.checkout(...args).pipe(Effect.tap(work => Effect.sync(() => (file = work.news)))),
        }))
      ).pipe(Layer.provide(hostSandbox(where.origin))),
      session
    );
    const agents = Object.fromEntries(Object.entries(small.agents).map(([k, a]) => [k, { ...a, tools: ['read'] }]));
    const done = await Effect.runPromise(
      runWorkflow({ ...flow, concurrency: 'queue' }, begun(), { ...small, agents }).pipe(
        Effect.provide(layer),
        Effect.provide(TestClock.layer())
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
   * The doubles, where the first session says `m` on the tracker while it works. With `cut`, it then lets a minute pass and
   * works until it is cut short; else it plays the first turn.
   */
  const during = (where: ReturnType<typeof world>, m: Event, turns: SessionEvent[][], cut = false) => {
    const specs: SessionSpec[] = [];
    const session = Layer.effect(
      Session,
      Effect.map(Session, s => ({
        open: (spec: SessionSpec) => {
          if (specs.push(spec) > 1) return s.open(spec);
          const said = Stream.fromEffectDrain(Effect.sync(() => say(where, m)));
          if (!cut) return Stream.concat(said, s.open(spec));
          const minute = Effect.gen(function* () {
            yield* Effect.promise(() => new Promise(r => setTimeout(r, 50)));
            yield* TestClock.adjust('1 minute');
            return yield* Effect.never;
          });
          return Stream.make(start('a')).pipe(Stream.concat(said), Stream.concat(Stream.fromEffectDrain(minute)));
        },
      }))
    ).pipe(Layer.provide(replaySession(turns)));
    const layer = Layer.mergeAll(
      folderTracker(where.tracker),
      fileStore(where.data),
      hostSandbox(where.origin),
      session
    );
    const go = (w: typeof flow) =>
      Effect.runPromise(runWorkflow(w, begun(), small).pipe(Effect.provide(layer), Effect.provide(TestClock.layer())));
    return { specs, go };
  };
  const bye = comment(7, 'ana', true, '/agent say bye too', later(1));
  const greet = [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)];

  it('steer: a comment made while the session works reaches it in one more turn of the same session', async () => {
    const where = world();
    const { specs, go } = during(where, bye, [greet, [start('a'), reply(push, pull)]]);
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
    const ends = readTrace(where.data, done.id).flatMap(t => ('session' in t ? [t.session.ended] : []));
    expect(ends[0]).toBe('human');
  });

  it('cancel parks a working run with its session, and stop ends it, whatever the concurrency', async () => {
    const parked = await during(world(), comment(7, 'ana', true, '/agent:cancel', later(1)), [], true).go(flow);
    expect(parked).toMatchObject({ status: 'waiting', reason: cancelled, sessions: { implement: { id: 'a' } } });
    const stop = comment(7, 'ana', true, '/agent:stop wrong issue', later(1));
    const stopped = await during(world(), stop, [], true).go({ ...flow, concurrency: 'queue' });
    expect(stopped).toMatchObject({ status: 'stopped', reason: 'wrong issue' });
  });

  const assigned = { ...small, workflows: { issue: { ...flow, on: { issues: { label: 'agentgraph' } } } } };
  const labelled = (actor: string, trusted: boolean, kind: 'label' | 'unlabel', at: string): Event => ({
    id: `${kind}-${at}`,
    bot: false,
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
    expect(readFileSync(issuePath(where.tracker, 7, 'reactions'), 'utf8')).toBe('eyes #7\n');
    expect(reactions(where.data, asked!.id)).toEqual([true]);
    expect(findStatus(where.tracker, 7)).toBe('stopped');
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
    id: `label-${at}`,
    bot: false,
    issue: 7,
    kind: 'label',
    actor,
    trusted,
    at,
    label: 'agent:ready',
  });

  it("starts a mention workflow on a maintainer's agent:ready, never on a bot's or an outsider's, and once per issue", async () => {
    const where = world();
    writeIssueAt(issuePath(where.tracker, 7, 'events.jsonl'), '');
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

  it('looks past a merged pull request GitHub refuses to show', async () => {
    const where = world();
    writeIssueAt(issuePath(where.tracker, 8), '---\ntitle: Merged\nstate: merged\nauthor: morgan\nlabels: []\n---\n');
    say(where, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at: '2026-10-16T00:00:01.000Z' });
    const tracker = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        issue: (n: number) =>
          n === 8 ? Effect.fail(new TrackerError({ status: 404, message: 'Not Found' })) : f.issue(n),
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const session = replaySession([[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    const layer = Layer.mergeAll(tracker, fileStore(where.data), hostSandbox(where.origin), session);
    const runs = await Effect.runPromise(scanIssuesAndRunningRuns(ready).pipe(Effect.provide(layer)));
    expect(runs.map(r => [r.issue, r.status])).toEqual([[7, 'waiting']]);
  });

  it('asks once after two tries, in one new comment that mentions who spoke', async () => {
    const where = world();
    const { run } = services(where, [
      [start('a'), wrote('hello.txt', 'TODO\n'), reply(push, pull)],
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
    ]);
    const asked = await run(runWorkflow(flow, begun(), small));
    const issue = await run(Effect.flatMap(Tracker, f => f.issue(7)));
    expect(asked).toMatchObject({ status: 'waiting', tries: 1 });
    expect(findStatus(where.tracker, 7)).toBe('needs-answer');
    expect(bodies(issue)).toEqual(['/agent', `@morgan Hello or hi?\n\n${replyHint}`]);
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
      [start('a'), wrote('hello.txt', 'TODO\n'), reply(push, pull)],
      [start('a'), reply(push, pull)],
      [start('a'), ...(fixed ? [wrote('hello.txt', 'hello\n')] : []), reply(push, pull)],
    ]);
    const done = await run(
      runWorkflow(typed, begin(typed, { id: 'run-7', issue: 7, started: fresh().started }), checked)
    );
    expect(specs).toHaveLength(3);
    expect(specs[2]!.prompt).toContain(findings);
    expect(done).toMatchObject({ status: fixed ? 'done' : 'waiting', tries: fixed ? 2 : 3 });
    const issue = bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))));
    expect(issue.join('\n')).not.toContain(findings);
    if (!fixed) {
      expect(done.reason).toBe(
        'implement failed after 3 tries (checks: types).\n\ntypes: hello.txt:1: TODO remains\n\nHow should I proceed?'
      );
    }
    expect(issue.filter(b => b.startsWith('@morgan implement failed after'))).toHaveLength(fixed ? 0 : 1);
    const outcomes = readTrace(where.data, 'run-7').flatMap(t => ('outcome' in t ? [t.outcome.kind] : []));
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
      [start('a'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      [start('r'), reply({ kind: 'comment', body: 'Fine.' })],
    ]);
    await run(
      runWorkflow(reviewed, begin(reviewed, { id: 'run-7', issue: 7, started: '2026-10-16T00:00:01.000Z' }), small)
    );
    expect(specs[0]!.prompt).not.toContain('## The change on the branch');
    expect(specs[1]!.prompt).toMatch(/## The change on the branch\n\n````diff\n[\s\S]*\+hello\n````/);
  });

  it('says nothing on the issue while a run without a branch works through its steps', async () => {
    const where = world();
    const { branch: _branch, ...base } = flow;
    const unbranched = {
      ...base,
      steps: [
        { name: 'implement', does: { agent: 'implementor' }, checks: [], tries: 1 },
        { name: 'review', does: { agent: 'reviewer' }, checks: [], tries: 1 },
      ],
    };
    const { run } = services(where, [
      [start('a'), reply()],
      [start('r'), reply()],
    ]);
    await run(runWorkflow(unbranched, begun(), { ...small, workflows: { issue: unbranched } }));
    expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))))).toEqual(['/agent']);
    expect(findStatus(where.tracker, 7)).toBe('done');
  });

  it('tells a waiting run how to be answered under its question', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    await run(runWorkflow(flow, begun(), small));
    const issue = bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))));
    expect(issue.filter(b => b.includes(replyHint))).toEqual([`@morgan Hello or hi?\n\n${replyHint}`]);
  });

  it('asks the next question in a new comment after an answer', async () => {
    const where = world();
    const { run } = services(where, [[start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })]]);
    await run(runWorkflow(flow, begun(), small));
    where.human('/agent hi', new Date().toISOString());
    await services(where, [[start('a'), reply({ kind: 'ask', question: 'Hi with a dot?' })]]).run(tick(small, 7));
    expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))))).toEqual([
      '/agent',
      `@morgan Hello or hi?\n\n${replyHint}`,
      '/agent hi',
      `@morgan Hi with a dot?\n\n${replyHint}`,
    ]);
  });

  it('lets an agent answer a review comment by the id its context shows, on the pull request', async () => {
    const where = world();
    pullRequest(where);
    const at = '2026-10-16T00:00:03.000Z';
    const line = { id: 'r1', author: 'morgan', body: 'why hello?', at, path: 'hello.txt', line: 1 };
    say(where, { ...comment(8, 'morgan', true, 'why hello?', at), comment: line });
    const { specs, run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Asked for.', under: 'r1' })]]);
    await run(runWorkflow(flow, { ...begun(), said: [{ issue: 7 }] }, small));
    expect(specs[0]!.prompt).toContain('@morgan on hello.txt:1, id r1: why hello?');
    const pr = (await run(Effect.flatMap(Tracker, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under, c.path])).toEqual([
      ['Asked for.', 'r1', 'hello.txt'],
    ]);
  });

  it('replies on the pull request that holds the thread when the run has no branch', async () => {
    const where = world();
    pullRequest(where);
    const at = '2026-10-16T00:00:03.000Z';
    const line = {
      id: 'r1',
      author: 'morgan',
      body: '/agent question only why hello?',
      at,
      path: 'hello.txt',
      line: 1,
    };
    say(where, { ...comment(8, 'morgan', true, line.body, at), comment: line });
    const { branch: _branch, ...unbranched } = flow;
    const { run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Asked for.', under: 'r1' })]]);
    const said = [{ issue: 8, under: 'r1' }];
    const done = await run(
      runWorkflow(unbranched, { ...begun(), said }, { ...small, workflows: { issue: unbranched } })
    );
    const pr = (await run(Effect.flatMap(Tracker, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(done.status).toBe('done');
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([['Asked for.', 'r1']]);
  });

  it('replies under the thread root on the pull request when the run has no branch and was woken by a reply', async () => {
    const where = world();
    pullRequest(where);
    const at = '2026-10-16T00:00:03.000Z';
    const root = { id: 'r1', author: 'morgan', body: 'why hello?', at, path: 'hello.txt', line: 1 };
    const answer = { ...root, id: 'r2', body: '/agent question only', under: 'r1' };
    say(where, { ...comment(8, 'morgan', true, root.body, at), comment: root });
    say(where, { ...comment(8, 'morgan', true, answer.body, at), comment: answer });
    const { branch: _branch, ...unbranched } = flow;
    const { run } = services(where, [[start('a'), reply({ kind: 'comment', body: 'Asked for.', under: 'r1' })]]);
    const said = [{ issue: 8, under: 'r2' }];
    const done = await run(
      runWorkflow(unbranched, { ...begun(), said }, { ...small, workflows: { issue: unbranched } })
    );
    const pr = (await run(Effect.flatMap(Tracker, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(done.status).toBe('done');
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body, c.under])).toEqual([['Asked for.', 'r1']]);
  });

  it('asks on the pull request once there is one, and replies under a review comment', async () => {
    const where = world();
    pullRequest(where);
    const { run } = services(where, [
      [start('a'), reply({ kind: 'ask', question: 'Hello or hi?' })],
      [start('a'), reply({ kind: 'ask', question: 'And bye?' })],
      [start('a'), reply({ kind: 'comment', body: 'Said bye.' })],
    ]);
    const at = () => new Date(Date.now() + 1).toISOString();
    let review = comment(8, 'morgan', true, '/agent yes, bye too', '');
    const [again, done] = await run(
      Effect.gen(function* () {
        yield* runWorkflow(flow, begun(), small);
        say(where, comment(8, 'morgan', true, '/agent hello', at()));
        const [again] = yield* tick(small, 7);
        const now = at();
        review = { ...review, at: now, comment: { ...review.comment!, at: now, id: now } };
        say(where, { ...review, comment: { ...review.comment!, path: 'hello.txt', line: 1 } });
        const [done] = yield* tick(small, 7);
        return [again, done];
      })
    );
    expect(again).toMatchObject({ status: 'waiting', said: [{ issue: 8 }] });
    expect(done).toMatchObject({ status: 'done', said: [{ issue: 8 }] });
    const pr = (await run(Effect.flatMap(Tracker, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body.split('\n')[0], c.under, c.path])).toEqual([
      ['@morgan Hello or hi?', undefined, undefined],
      ['@morgan And bye?', undefined, undefined],
      ['Said bye.', review.at, 'hello.txt'],
    ]);
    expect(readFileSync(issuePath(where.tracker, 8), 'utf8')).toMatch(
      /\n---\n\n<!-- agentgraph status -->\n> ※ Done\n\n<details><summary>Runs<\/summary>\n\n[^]*\| issue \| implement \| done \| \$0\.00 of \$10 \|[^]*<!-- end agentgraph status -->\n\nCloses #7\n/
    );
    expect(readFileSync(issuePath(where.tracker, 7), 'utf8')).not.toContain('agentgraph status');
    expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(7))))).toEqual(['/agent']);
  });
});
