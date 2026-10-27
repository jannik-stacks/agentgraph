import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chunk, Deferred, Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { scanIssuesAndRunningRuns, tick } from '../src/engine.ts';
import { fileForge, Forge } from '../src/forge.ts';
import type { Event } from '../src/event.ts';
import type { Proposal } from '../src/proposal.ts';
import { loadGraph } from '../src/folder.ts';
import type { Sandbox } from '../src/sandbox.ts';
import type { Session } from '../src/session.ts';
import type { SessionEvent } from '../src/trace.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin, type Run } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { replaySession } from './doubles/session.ts';
import { harnesses, reply, seeded, start } from './fixtures.ts';
import { git } from './kit.ts';

const graph = await Effect.runPromise(loadGraph(join(import.meta.dirname, '..', 'examples', 'sandbox'), harnesses));

const unbounded = { ...graph, checks: { ...graph.checks, sized: { ...graph.checks.sized!, run: 'true' } } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = (s: number) => `2026-10-16T00:00:${String(s).padStart(2, '0')}.000Z`;

/** A bare origin with main, and a forge holding `issues` as `[number, author, parent?]`, #1 labelled triage by a maintainer. */
const world = (issues: [number, string, number?][] = [[1, 'morgan']]) => {
  const { root, seed, data } = seeded('triage', { 'README.md': 'demo\n' });
  dirs.push(root);
  git(root, 'clone', '-q', '--bare', seed, 'origin.git');
  const forge = join(root, 'forge');
  mkdirSync(forge);
  for (const [n, author, parent] of issues)
    writeFileSync(
      join(forge, `${n}.md`),
      `---\ntitle: Issue ${n}\nstate: open\nauthor: ${author}\nlabels: []\n${parent ? `parent: ${parent}\n` : ''}---\n\nMake the package do ${n} things.\n`
    );
  const label = (issue: number) =>
    appendFileSync(
      join(forge, `${issue}.jsonl`),
      `${JSON.stringify({ issue, kind: 'label', label: 'triage', actor: 'morgan', trusted: true, at: at(issue) } satisfies Event)}\n`
    );
  return { origin: join(root, 'origin.git'), forge, data, label };
};

const turn = (...proposals: unknown[]): SessionEvent[] => [start('s'), reply(...proposals)];

const part = (title: string, size: string, more: object = {}) => ({
  kind: 'issue',
  relation: 'part',
  title,
  body: `Change ${title}.\n\n## Done when\n\n- the tests cover ${title}`,
  size,
  ...more,
});

const follow = (title: string) => ({
  kind: 'issue',
  relation: 'follow-up',
  title,
  body: `Change ${title}.\n\n## Done when\n\n- it is changed`,
});

const splitIntoPartsAndDocsFollowUp = () => [
  turn(
    { kind: 'label', add: ['size/XL'] },
    part('the parser', 'M'),
    part('the printer', 'L', { stacks_on: 1 }),
    follow('the docs')
  ),
];

const run = <A, E>(
  where: ReturnType<typeof world>,
  turns: SessionEvent[][],
  effect: Effect.Effect<A, E, Forge | Store | Session | Sandbox>
) => {
  const layer = Layer.mergeAll(
    fileForge(where.forge),
    fileStore(where.data),
    hostSandbox(where.origin),
    replaySession(turns)
  );
  return Effect.runPromise(effect.pipe(Effect.provide(layer))).then(value => ({ value }));
};

const issues = (where: ReturnType<typeof world>) =>
  Effect.runPromise(Effect.flatMap(Forge, f => f.issues()).pipe(Effect.provide(fileForge(where.forge))));
const issue = (where: ReturnType<typeof world>, n: number) =>
  Effect.runPromise(Effect.flatMap(Forge, f => f.issue(n)).pipe(Effect.provide(fileForge(where.forge))));
const runs = (where: ReturnType<typeof world>) =>
  Effect.runPromise(Effect.flatMap(Store, s => s.list()).pipe(Effect.provide(fileStore(where.data))));

describe('triage', () => {
  it('labels an issue of size L or smaller and files nothing', async () => {
    const where = world();
    where.label(1);
    const { value } = await run(where, [turn({ kind: 'label', add: ['size/S'] })], tick(graph));
    expect(value.map(r => [r.workflow, r.issue, r.status])).toEqual([['triage', 1, 'done']]);
    expect((await issues(where)).map(t => [t.number, t.labels])).toEqual([[1, ['size/S', 'agentgraph:done']]]);
  });

  it('does not end done on a comment alone', async () => {
    const where = world();
    where.label(1);
    const { value } = await run(where, Array(3).fill(turn({ kind: 'comment', body: 'small' })), tick(graph));
    expect(value[0]).toMatchObject({ issue: 1, status: 'waiting' });
    expect(value[0]!.reason).toContain('No size label proposed');
  });

  it('treats an actor outside the trust list as untrusted in the forge folder', async () => {
    const where = world([[1, 'morgan']]);
    where.label(1);
    const read = (trust: string[]) =>
      Effect.runPromise(
        Effect.flatMap(Forge, f => f.issue(1)).pipe(Effect.provide(fileForge(where.forge, undefined, trust)))
      );
    expect((await read(['morgan'])).events[0]).toMatchObject({ trusted: true });
    expect((await read(['ana'])).events[0]).toMatchObject({ trusted: false });
    expect((await read(['ana'])).title).toMatch(/withheld/);
  });

  it('starts runs only on issues in the graph milestone', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    const file = join(where.forge, '1.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('labels: []', 'labels: []\nmilestone: v1'));
    where.label(1);
    where.label(2);
    const scoped = { ...graph, milestone: 'v1' };
    const first = await run(where, [turn({ kind: 'label', add: ['size/S'] })], tick(scoped));
    expect(first.value.map(r => r.issue)).toEqual([1]);
    const swept = await run(where, [], scanIssuesAndRunningRuns(scoped));
    expect(swept.value.map(r => r.issue)).toEqual([]);
    const rest = await run(where, [turn({ kind: 'label', add: ['size/S'] })], tick(graph));
    expect(rest.value.map(r => r.issue)).toEqual([2]);
  });

  it('posts each part and follow-up once when the runner stopped after posting and before recording it', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    writeFileSync(
      join(where.forge, '2.md'),
      '---\ntitle: the docs\nstate: open\nauthor: morgan\nlabels: []\n---\n\nDocs.\n'
    );
    where.label(1);
    const crash = (after: (p: Proposal) => boolean) =>
      Effect.runPromise(
        Effect.gen(function* () {
          const posted = yield* Deferred.make<'posted'>();
          const stopping = Layer.effect(
            Forge,
            Effect.map(Forge, f => ({
              ...f,
              apply: (n: number, p: Proposal, work?: Parameters<typeof f.apply>[2]) =>
                f
                  .apply(n, p, work)
                  .pipe(
                    Effect.tap(() =>
                      after(p) ? Effect.andThen(Deferred.succeed(posted, 'posted'), Effect.never) : Effect.void
                    )
                  ),
            }))
          ).pipe(Layer.provide(fileForge(where.forge)));
          const layer = Layer.mergeAll(
            stopping,
            fileStore(where.data),
            hostSandbox(where.origin),
            replaySession(splitIntoPartsAndDocsFollowUp())
          );
          return yield* Effect.raceFirst(Effect.provide(tick(unbounded), layer), Deferred.await(posted));
        })
      );
    expect(await crash(p => p.kind === 'issue' && p.title === 'the printer')).toBe('posted');
    expect(await crash(p => p.kind === 'comment' && p.body.startsWith('Change the docs'))).toBe('posted');
    await run(where, splitIntoPartsAndDocsFollowUp(), tick(unbounded));
    const children = (await issues(where)).filter(t => t.parent === 1);
    expect(children.map(t => t.title)).toEqual(['the parser', 'the printer']);
    const docs = (await issue(where, 2)).events.flatMap(m => (m.comment ? [m.comment.body] : []));
    expect(docs.filter(b => b.startsWith('Change the docs'))).toHaveLength(1);
  });

  it('splits an XL issue into stacked children with labels, lines and a task list, and triages the XL child again', async () => {
    const where = world();
    where.label(1);
    const turns = [
      turn(
        { kind: 'label', add: ['size/XL'] },
        part('the parser', 'M'),
        part('the printer', 'L', { stacks_on: 1 }),
        part('the docs', 'XL', { stacks_on: 2, depends_on: [1] })
      ),
    ];
    await run(where, turns, tick(unbounded));
    const all = await issues(where);
    const children = all.filter(t => t.parent === 1);
    expect(children.map(t => [t.number, t.title, t.labels])).toEqual([
      [2, 'the parser', ['size/M']],
      [3, 'the printer', ['size/L']],
      [4, 'the docs', ['size/XL']],
    ]);
    expect(children[0]!.body).not.toMatch(/stacks on|depends on/i);
    expect(children[1]!.body).toMatch(/\n\nStacks on #2$/);
    expect(children[2]!.body).toMatch(/\n\nStacks on #3\nDepends on #2$/);
    expect(all.find(t => t.number === 1)!.labels).toContain('size/XL');
    const said = (await issue(where, 1)).events.flatMap(m => (m.comment ? [m.comment.body] : []));
    expect(said).toContain('Split into:\n\n- [ ] #2\n- [ ] #3\n- [ ] #4');
    expect((await runs(where)).map(r => [r.workflow, r.issue, r.status]).sort()).toEqual([
      ['triage', 1, 'done'],
      ['triage', 4, 'running'],
    ]);
  });

  it('files a follow-up as a plain issue, and starts no run on it or on the bot own label or comment', async () => {
    const where = world();
    where.label(1);
    await run(where, [turn({ kind: 'label', add: ['size/S'] }, follow('Tidy the README'))], tick(unbounded));
    const filed = await issue(where, 2);
    expect([filed.title, filed.parent, filed.labels]).toEqual(['Tidy the README', undefined, ['follow-up']]);
    expect(filed.body).toMatch(/## Done when[\s\S]*\n\nFound while working on #1$/);
    expect((await issue(where, 1)).events.some(m => m.comment?.body.startsWith('Split into'))).toBe(false);

    const bot = Layer.mergeAll(fileForge(where.forge), fileStore(where.data));
    await Effect.runPromise(
      Effect.flatMap(Forge, f =>
        Effect.all([f.apply(2, { kind: 'label', add: ['triage'] }), f.apply(2, { kind: 'comment', body: '/agent' })])
      ).pipe(Effect.provide(bot))
    );
    expect((await run(where, [], tick(graph))).value).toEqual([]);
    expect((await run(where, [], scanIssuesAndRunningRuns(graph))).value).toEqual([]);
    expect((await runs(where)).map(r => [r.workflow, r.issue, r.status])).toEqual([['triage', 1, 'done']]);
  });

  it('files a graph change like a follow-up, labelled graph', async () => {
    const where = world();
    where.label(1);
    const graphIssue = { ...follow('Check that new fields are documented'), relation: 'graph' };
    await run(where, [turn({ kind: 'label', add: ['size/S'] }, graphIssue)], tick(unbounded));
    const filed = await issue(where, 2);
    expect([filed.title, filed.parent, filed.labels]).toEqual([
      'Check that new fields are documented',
      undefined,
      ['graph'],
    ]);
    expect(filed.body).toMatch(/\n\nFound while working on #1$/);
    expect((await runs(where)).map(r => r.issue)).toEqual([1]);
  });

  it('adds a follow-up or graph change to the open issue of its title, which the agent sees listed', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    where.label(1);
    const two = join(where.forge, '2.md');
    writeFileSync(two, readFileSync(two, 'utf8').replace('labels: []', 'labels: [graph]'));
    const again = { ...follow('Issue 2'), relation: 'graph' };
    await run(where, [turn({ kind: 'label', add: ['size/S'] }, again)], tick(unbounded));
    expect((await issues(where)).map(t => t.number)).toEqual([1, 2]);
    const said = (await issue(where, 2)).events.flatMap(m => (m.comment ? [m.comment.body] : []));
    expect(said).toEqual(['Change Issue 2.\n\n## Done when\n\n- it is changed\n\nFound while working on #1']);
    const [triage] = await runs(where);
    const opened = readFileSync(join(where.data, triage!.id, 'trace.jsonl'), 'utf8');
    expect(opened).toContain(
      'Open follow-up and graph issues. To add to one, propose an issue with its exact title:\\n- #2 Issue 2'
    );
  });

  it('refuses a label that starts a workflow', async () => {
    const where = world();
    where.label(1);
    const marked = await run(where, Array(3).fill(turn({ kind: 'label', add: ['size/S', 'triage'] })), tick(graph));
    expect(marked.value[0]!.reason).toContain('label failed: only a human adds triage');
    expect((await issues(where)).map(t => t.number)).toEqual([1]);
  });

  it('files no children from an issue three levels deep, and begins no triage on an XL child at the cap', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan', 1],
      [3, 'morgan', 2],
      [4, 'morgan', 3],
    ]);
    where.label(4);
    const { value } = await run(where, Array(3).fill(turn(part('a part', 'S'))), tick(unbounded, 4));
    expect(value[0]).toMatchObject({ issue: 4, status: 'waiting' });
    expect(value[0]!.reason).toContain('#4 sits 3 issues deep');
    expect((await issues(where)).map(t => t.number)).toEqual([1, 2, 3, 4]);

    where.label(3);
    await run(where, [turn(part('a big part', 'XL'))], tick(unbounded, 3));
    expect((await issues(where)).filter(t => t.parent === 3).map(t => [t.number, t.labels])).toEqual([
      [4, ['agentgraph:waiting']],
      [5, ['size/XL']],
    ]);
    expect((await runs(where)).some(r => r.issue === 5)).toBe(false);
  });

  it('files nothing from an outsider issue, whatever the agent proposes, and refuses positions that are not earlier', async () => {
    const where = world([
      [1, 'mallory[bot]'],
      [2, 'morgan'],
    ]);
    where.label(1);
    const { value } = await run(where, Array(3).fill(turn(part('spam', 'S'))), tick(graph, 1));
    expect(value[0]!.reason).toContain('#1 is withheld text from an outsider');
    expect((await issue(where, 1)).body).toBe('(issue text by @mallory[bot] withheld: not a collaborator)');

    where.label(2);
    const late = await run(where, Array(3).fill(turn(part('one', 'S', { stacks_on: 1 }))), tick(graph, 2));
    expect(late.value[0]!.reason).toContain('one: stacks_on and depends_on name an earlier issue here by position');
    expect((await issues(where)).map(t => t.number)).toEqual([1, 2]);
  });
});

describe('ordering', () => {
  it('does not drive a run while an issue it stacks on or depends on is open without a pull request', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    appendFileSync(join(where.forge, '2.md'), '\nStacks on #1\n');
    const implement = graph.workflows.issue!;
    const waiting = begin(implement, { id: 'issue-2', issue: 2, started: at(5) });
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(waiting)).pipe(Effect.provide(fileStore(where.data))));
    const { value } = await run(where, [], tick(graph, 2, true));
    expect(value).toEqual([]);
    expect((await runs(where)).map(r => [r.id, r.step, r.status, r.tries])).toEqual([
      ['issue-2', 'implement', 'running', 0],
    ]);

    writeFileSync(join(where.forge, '1.md'), '---\ntitle: Issue 1\nstate: closed\nauthor: morgan\n---\n\nDone.\n');
    const question = 'The dependency is closed; which implementation should I use?';
    const after = await run(where, [turn({ kind: 'ask', question })], tick(graph, 2, true));
    expect(after.value.map(r => [r.id, r.step, r.status, r.reason, r.tries])).toEqual([
      ['issue-2', 'implement', 'waiting', question, 0],
    ]);
    expect(after.value[0]!.sessions.implement).toMatchObject({ id: 's' });
  });

  it('waits on a "Depends on" issue until it is closed, even once it has a pull request', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    appendFileSync(join(where.forge, '2.md'), '\nDepends on #1\n');
    writeFileSync(
      join(where.forge, '3.md'),
      '---\ntitle: Fix 1\nstate: open\nauthor: agentgraph[bot]\n---\n\nCloses #1\n'
    );
    mkdirSync(join(where.forge, '3'), { recursive: true });
    writeFileSync(
      join(where.forge, '3', 'pull.json'),
      JSON.stringify({ branch: 'agentgraph/1', base: 'main', head: 'abc' })
    );
    const implement = graph.workflows.issue!;
    const waiting = begin(implement, { id: 'issue-2', issue: 2, started: at(5) });
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(waiting)).pipe(Effect.provide(fileStore(where.data))));
    const { value } = await run(where, [], tick(graph, 2, true));
    expect(value).toEqual([]);
  });
});

describe('dispatch', () => {
  /** A trusted comment on #1. */
  const mention = (where: ReturnType<typeof world>, body: string) =>
    appendFileSync(
      join(where.forge, '1.jsonl'),
      `${JSON.stringify({ issue: 1, kind: 'comment', actor: 'morgan', trusted: true, at: at(1), comment: { id: 'c1', author: 'morgan', body, at: at(1) } } satisfies Event)}\n`
    );

  it('starts triage from the router, which waits on it quietly and decides once it is done', async () => {
    const where = world();
    mention(where, '/agent size this');
    const first = await run(where, [turn({ kind: 'run', workflow: 'triage', issue: 1 })], tick(graph));
    const router = first.value[0]!;
    const [child] = (await runs(where)).filter(r => r.workflow === 'triage');
    expect(child).toMatchObject({ issue: 1, status: 'running', by: router.id });
    expect(router).toMatchObject({ workflow: 'router', status: 'waiting', reason: `waiting on ${child!.id}` });

    await run(where, [turn({ kind: 'label', add: ['size/S'] })], tick(graph));
    expect((await runs(where)).find(r => r.id === child!.id)!.status).toBe('done');
    const last = await run(where, [turn({ kind: 'comment', body: 'Sized S; agent:ready builds it.' })], tick(graph));
    expect(last.value.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);

    const said = (await issue(where, 1)).events.flatMap(m => (m.comment && !m.trusted ? [m.comment.body] : []));
    expect(said.some(b => b.includes('waiting on'))).toBe(false);
    expect(said).toContain('Sized S; agent:ready builds it.');
    const trace = await Effect.runPromise(
      Effect.flatMap(Store, s => Stream.runCollect(s.read(router.id))).pipe(Effect.provide(fileStore(where.data)))
    );
    expect(Chunk.toArray(trace).flatMap(t => ('outcome' in t ? [t.outcome] : []))).toContainEqual({
      kind: 'answer',
      text: 'triage on #1 is done',
    });
  });

  it('hands /agent beside a live triage to the router, which tells the triage to stop', async () => {
    const where = world();
    const triage = {
      ...begin(graph.workflows.triage!, { id: 'triage-1', issue: 1, started: at(0) }),
      status: 'waiting' as const,
      reason: 'Which size?',
    };
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(triage)).pipe(Effect.provide(fileStore(where.data))));
    mention(where, '/agent stop the triage, it is not needed');
    const first = await run(where, [turn({ kind: 'tell', issue: 1, text: 'stop not needed' })], tick(graph));
    expect(first.value.map(r => [r.workflow, r.status])).toEqual([['router', 'done']]);
    const trace = await Effect.runPromise(
      Effect.flatMap(Store, s => Stream.runCollect(s.read('triage-1'))).pipe(Effect.provide(fileStore(where.data)))
    );
    expect(Chunk.toArray(trace).flatMap(t => ('told' in t ? [t.told] : []))).toEqual([
      { text: 'stop not needed', by: first.value[0]!.id },
    ]);
    await run(where, [], tick(graph));
    expect((await runs(where)).find(r => r.id === 'triage-1')).toMatchObject({ status: 'stopped' });
  });

  it('refuses a tell where no run is live', async () => {
    const where = world();
    mention(where, '/agent tell the triage to stop');
    const { value } = await run(where, Array(3).fill(turn({ kind: 'tell', issue: 1, text: 'stop' })), tick(graph));
    expect(value[0]!.reason).toContain('no live run on #1 to tell');
  });

  it('refuses a run of a workflow without on: dispatch, and a run from an agent that does not return run', async () => {
    const where = world();
    mention(where, '/agent build this');
    const { value } = await run(where, [turn({ kind: 'run', workflow: 'issue', issue: 1 })], tick(graph));
    expect(value[0]!.reason).toContain('run failed: issue is not a workflow with on: dispatch');

    const other = world();
    other.label(1);
    const tried = await run(other, Array(3).fill(turn({ kind: 'run', workflow: 'triage', issue: 1 })), tick(unbounded));
    expect(tried.value[0]!.reason).toContain('triage may not propose run');
    expect((await runs(other)).map(r => r.workflow)).toEqual(['triage']);
  });
});

const putRun = (where: ReturnType<typeof world>, r: Run) =>
  Effect.runPromise(Effect.flatMap(Store, s => s.put(r)).pipe(Effect.provide(fileStore(where.data))));
const shut = (where: ReturnType<typeof world>, n: number, state: 'closed' | 'merged') => {
  const file = join(where.forge, `${n}.md`);
  writeFileSync(file, readFileSync(file, 'utf8').replace('state: open', `state: ${state}`));
};
const openPull = (where: ReturnType<typeof world>, n: number, branch: string) => {
  writeFileSync(join(where.forge, `${n}.md`), `---\ntitle: Pull ${n}\nstate: open\nauthor: morgan\n---\n\nCloses #1\n`);
  mkdirSync(join(where.forge, String(n)), { recursive: true });
  writeFileSync(
    join(where.forge, String(n), 'pull.json'),
    JSON.stringify({ branch, base: 'main', head: 'x', baseSha: 'b1' })
  );
};
const sayOn = (where: ReturnType<typeof world>, m: Event) =>
  appendFileSync(join(where.forge, `${m.issue}.jsonl`), `${JSON.stringify(m)}\n`);
const command = (issue: number, body: string, s: number): Event => ({
  issue,
  kind: 'comment',
  actor: 'morgan',
  trusted: true,
  at: at(s),
  comment: { id: `c${s}`, author: 'morgan', body, at: at(s) },
});
const ended = (workflow: 'issue' | 'triage', issue: number, s: number): Run => ({
  ...begin(graph.workflows[workflow]!, { id: `${workflow}-${issue}`, issue, started: at(s) }),
  status: 'done',
});
const filed = turn({ kind: 'comment', body: 'Filed a follow-up.' });

describe('/agent after a close or merge', () => {
  it('starts the router on a command on a closed issue', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    shut(where, 1, 'closed');
    await putRun(where, ended('triage', 2, 0));
    sayOn(where, command(1, '/agent file a follow-up for the docs', 5));
    const { value } = await run(where, [filed], scanIssuesAndRunningRuns(graph));
    expect(value.map(r => [r.workflow, r.issue, r.status])).toEqual([['router', 1, 'done']]);
  });

  it('starts the router on a command on a merged pull request whose run is done', async () => {
    const where = world();
    openPull(where, 2, 'agentgraph/1');
    shut(where, 1, 'closed');
    shut(where, 2, 'merged');
    await putRun(where, ended('issue', 1, 0));
    sayOn(where, { issue: 2, kind: 'merged', actor: 'morgan', trusted: true, at: at(3) });
    sayOn(where, command(2, '/agent file a follow-up for the docs', 5));
    const { value } = await run(where, [filed], scanIssuesAndRunningRuns(graph));
    expect(value.map(r => [r.workflow, r.issue, r.status])).toEqual([['router', 2, 'done']]);
  });

  it('starts the router on a command on an open pull request no run works on', async () => {
    const where = world();
    openPull(where, 2, 'feature/docs');
    git(where.origin, 'branch', 'feature/docs', 'main');
    await putRun(where, ended('triage', 1, 0));
    sayOn(where, command(2, '/agent file a follow-up for the docs', 5));
    const { value } = await run(where, [filed], scanIssuesAndRunningRuns(graph));
    expect(value.map(r => [r.workflow, r.issue, r.status])).toEqual([['router', 2, 'done']]);
  });

  it('hands a command said before the merge to the router once the merge ends the run', async () => {
    const where = world();
    openPull(where, 2, 'agentgraph/1');
    await putRun(where, {
      ...begin(graph.workflows.issue!, { id: 'issue-1', issue: 1, started: at(0) }),
      step: 'merge',
      status: 'waiting',
    });
    sayOn(where, command(2, '/agent file a follow-up for the docs', 5));
    sayOn(where, { issue: 2, kind: 'merged', actor: 'morgan', trusted: true, at: at(6) });
    sayOn(where, { issue: 1, kind: 'closed', actor: 'morgan', trusted: true, at: at(6) });
    shut(where, 1, 'closed');
    shut(where, 2, 'merged');
    const { value } = await run(where, [filed], scanIssuesAndRunningRuns(graph));
    expect(value.map(r => [r.workflow, r.issue, r.status]).toSorted()).toEqual([
      ['issue', 1, 'done'],
      ['router', 2, 'done'],
    ]);
    expect(value.find(r => r.workflow === 'router')!.said).toEqual([{ issue: 2 }]);
  });
});
