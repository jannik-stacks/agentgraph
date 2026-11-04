import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { folderTracker, Tracker } from '../src/tracker.ts';
import type { Event } from '../src/event.ts';
import type { Proposal } from '../src/proposal.ts';
import { Sandbox, SandboxError } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { Trace, SessionEvent, SessionSpec } from '../src/trace.ts';
import { begin, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { makeTestGraph, reply, result, start, stop, wrote } from './fixtures.ts';
import { git, issuePath, writeIssueAt } from './kit.ts';
import { world, services, readTrace, bodies, driveStored, fresh, say, comment } from './world.ts';
import { runStepChecks } from '../src/run/check.ts';
import { runWorkflow } from '../src/run/drive.ts';

describe('stacks', () => {
  const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
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
      writeIssueAt(
        issuePath(where.tracker, 8, 'pull.json'),
        JSON.stringify({ branch: 'agentgraph/7', base: 'main', head })
      );
      return head;
    };
    writeIssueAt(
      issuePath(where.tracker, 8),
      '---\ntitle: Add hello\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
    );
    const head = move('hello.txt', 'hello\n');
    writeIssueAt(
      issuePath(where.tracker, 9),
      '---\ntitle: Say bye\nstate: open\nauthor: morgan\n---\n\nAdd bye.txt.\n\nStacks on #7\n'
    );
    return { head, move };
  };
  const pr10 = (where: ReturnType<typeof world>) => ({
    pull: JSON.parse(readFileSync(issuePath(where.tracker, 10, 'pull.json'), 'utf8')),
    body: readFileSync(issuePath(where.tracker, 10), 'utf8'),
    diff: readFileSync(issuePath(where.tracker, 10, 'diff.patch'), 'utf8'),
  });
  const saved = (where: ReturnType<typeof world>) =>
    JSON.parse(readFileSync(join(where.data, 'run-9', 'run.json'), 'utf8')) as Run;

  it('opens the pull request of an issue that stacks on #7 on its branch, with only its own change', async () => {
    const where = world();
    const { head } = parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(runWorkflow(flow, run9(), merging));
    expect(parked).toMatchObject({
      step: 'merge',
      status: 'waiting',
      base: { pull: 8, branch: 'agentgraph/7', sha: head },
    });
    expect(specs[0]!.prompt).toContain('pull requests go into agentgraph/7.');
    const pr = pr10(where);
    expect(pr.pull).toMatchObject({ branch: 'agentgraph/9', base: 'agentgraph/7' });
    expect(pr.body).toMatch(
      /\n\nCloses #9\n\nStacks on #8\n\n<details><summary>⁂<\/summary>\n\n<\/details>\n<!-- agentgraph run=run-9 [^\n]*-->\n?$/
    );
    expect(pr.diff).toContain('bye.txt');
    expect(pr.diff).not.toContain('hello.txt');
    expect(git(where.origin, 'rev-parse', 'agentgraph/9~1')).toBe(head);
  });

  it('with stacks off, opens the same issue as an independent pull request off main', async () => {
    const where = world();
    parent(where);
    const { specs, run } = services(where, [child()]);
    const parked = await run(runWorkflow(flow, run9(), { ...merging, stacks: false }));
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
        const waiting = yield* runWorkflow(flow, run9(), merging);
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
    await run(runWorkflow(flow, run9(), merging));
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

  it('traces a sandbox start error while following a stacked branch', async () => {
    const where = world();
    const { move } = parent(where);
    await services(where, [child()]).run(runWorkflow(flow, run9(), merging));
    move('more.txt', 'more\n');
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
    await Effect.runPromise(tick(merging, 9).pipe(Effect.provide(layer)));
    expect(readTrace(where.data, 'run-9')).toContainEqual(
      expect.objectContaining({ outcome: { kind: 'ask', question: 'SandboxError: sandbox image is missing' } })
    );
  });

  it('retries a refused stack follow from its last successful base', async () => {
    const where = world();
    const { move } = parent(where);
    let refused = true;
    const tracker = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({
        ...f,
        apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) => {
          if (p.kind === 'rebase' && !p.head && refused) {
            refused = false;
            return Effect.succeed({ proposal: p, ok: false, reason: 'temporary ref refusal', moved: true as const });
          }
          return f.apply(n, p, work);
        },
      }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const layer = Layer.mergeAll(tracker, fileStore(where.data), hostSandbox(where.origin), replaySession([child()]));
    const run = <A, E>(effect: Effect.Effect<A, E, Tracker | Store | Sandbox | Session>) =>
      Effect.runPromise(effect.pipe(Effect.provide(layer)));
    await run(runWorkflow(flow, run9(), merging));
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    const moved = move('more.txt', 'more\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9^')).toBe(moved);
    expect(bodies(await run(Effect.flatMap(Tracker, f => f.issue(9)))).join('\n')).not.toContain('could not follow');
  });

  it('says on the issue when the branch does not rebase cleanly and leaves it where it was', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child('hello and bye\n', 'hello.txt')]);
    await run(runWorkflow(flow, run9(), merging));
    const before = git(where.origin, 'rev-parse', 'agentgraph/9');
    const moved = move('hello.txt', 'hi\n');
    await run(tick(merging, 9));
    expect(git(where.origin, 'rev-parse', 'agentgraph/9')).toBe(before);
    expect(readFileSync(issuePath(where.tracker, 9, 'events.jsonl'), 'utf8')).toContain(
      '#8 moved and agentgraph/9 could not follow'
    );
    expect(saved(where).base?.sha).toBe(moved);
  });

  it('tries a conflicting follow once per base head and branch tip', async () => {
    const where = world();
    const { move } = parent(where);
    const { run } = services(where, [child('hello and bye\n', 'hello.txt')]);
    await run(runWorkflow(flow, run9(), merging));
    const conflicted = move('hello.txt', 'hi\n');
    const rebases = () =>
      readTrace(where.data, 'run-9').filter(t => 'applied' in t && t.applied.proposal.kind === 'rebase');
    await run(tick(merging, 9));
    await run(tick(merging, 9));
    expect(rebases()).toHaveLength(1);
    expect(saved(where).base).toMatchObject({ sha: conflicted, tip: git(where.origin, 'rev-parse', 'agentgraph/9') });
    const moved = move('more.txt', 'more\n');
    await run(tick(merging, 9));
    await run(tick(merging, 9));
    expect(rebases()).toHaveLength(2);
    expect(saved(where).base?.sha).toBe(moved);
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
    const kit = makeTestGraph('kit', {
      types: { run: `cp "$AGENTGRAPH_TRACES" ${seen}` },
      claims: { agent: 'claim-checker' },
    });
    const auditor = { ...kit.agents['claim-checker']!, tools: ['read'], reads: 'traces' as const };
    const small = { ...kit, agents: { ...kit.agents, 'claim-checker': auditor } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const read: string[] = [];
    const prompts: string[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        prompts.push(spec.prompt),
        read.push(...(spec.read ?? []).map(d => readFileSync(join(d, 'traces.md'), 'utf8'))),
        Stream.fromIterable<SessionEvent>([start('j'), result({ pass: false, why: 'no test run' }), stop])
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
    expect(prompts[0]).toContain(`\`${join(where.root, 'news', 'traces.md')}\`, an absolute path outside the checkout`);
  });

  const small = makeTestGraph('graph', { types: { run: '! grep -q TODO hello.txt' } });
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
    say(where, comment(7, 'morgan', true, '/agent:stop', '2026-10-16T00:00:06.000Z'));
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
    const sticky = bodies(await run(Effect.flatMap(Tracker, f => f.issue(7)))).filter(b =>
      b.startsWith('Agentgraph status: ')
    );
    expect(sticky).toHaveLength(1);
    expect(sticky[0]).toContain('| issue / implement | done |');
    expect(sticky[0]).toContain('| retro / implement | done |');
    expect(readFileSync(issuePath(where.tracker, 7), 'utf8')).toContain('labels: []');
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
    say(where, comment(7, 'morgan', true, '/agent:stop', '2026-10-16T00:00:04.000Z'));
    say(where, comment(7, 'morgan', true, '/agent:stop you rewrote the whole module', '2026-10-16T00:00:05.000Z'));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    expect((await run(tick(looking))).map(r => r.workflow)).toEqual(['retro']);
    expect(specs[0]!.prompt).toContain('said or pushed\n\n@morgan: /agent:stop you rewrote the whole module\n');
  });

  it('starts no retro from a refused or unknown command, even with text after it', async () => {
    const where = world();
    say(where, comment(7, 'morgan', true, '/agent:stop bad change', '2026-10-16T00:00:04.000Z'));
    say(where, comment(7, 'morgan', true, '/agent:restart wrong file', '2026-10-16T00:00:05.000Z'));
    say(where, comment(7, 'morgan', true, '/agent:bogus try again', '2026-10-16T00:00:06.000Z'));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(done());
    const touched = await run(tick({ ...looking, commands: { stop: false, restart: ['ana'] } }));
    expect([touched.map(r => r.workflow), specs]).toEqual([[], []]);
  });

  it('looks up no open issue a run never worked on', async () => {
    const where = world();
    writeIssueAt(issuePath(where.tracker, 12), '---\ntitle: Other\nstate: open\nauthor: morgan\n---\n\nElse.\n');
    say(where, comment(12, 'morgan', true, 'Unrelated.', '2026-10-16T00:00:05.000Z'));
    const asked: number[] = [];
    const counted = Layer.effect(
      Tracker,
      Effect.map(Tracker, f => ({ ...f, issue: (n: number) => (asked.push(n), f.issue(n)) }))
    ).pipe(Layer.provide(folderTracker(where.tracker)));
    const layer = Layer.mergeAll(counted, fileStore(where.data), hostSandbox(where.origin), replaySession([]));
    const go = <A, E>(e: Effect.Effect<A, E, Tracker | Store | Session | Sandbox>) =>
      Effect.runPromise(e.pipe(Effect.provide(layer)));
    await go(done());
    expect(await go(tick(looking))).toEqual([]);
    expect(asked).not.toContain(12);
  });

  it('takes what is said on a merged pull request as feedback on the issue its branch worked on', async () => {
    const where = world();
    writeIssueAt(
      issuePath(where.tracker, 8),
      '---\ntitle: Add hello\nstate: merged\nauthor: agentgraph[bot]\n---\n\nCloses #7\n'
    );
    writeIssueAt(
      issuePath(where.tracker, 8, 'pull.json'),
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
