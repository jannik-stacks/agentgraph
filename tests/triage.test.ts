import { appendFileSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Chunk, Effect, Layer, Stream } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { sweep, tick } from '../src/engine.ts';
import { fileForge, Forge, type Event } from '../src/forge.ts';
import { loadHub } from '../src/hub.ts';
import { host, type Sandbox } from '../src/sandbox.ts';
import { scripted, type Session, type SessionEvent } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { git, tmp } from './fixtures.ts';

const hub = await Effect.runPromise(loadHub(join(import.meta.dirname, '..', 'examples', 'sandbox')));

const unbounded = { ...hub, checks: { ...hub.checks, sized: { ...hub.checks.sized!, run: 'true' } } };

const dirs: string[] = [];
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const at = (s: number) => `2026-10-16T00:00:${String(s).padStart(2, '0')}.000Z`;

/** A bare origin with main, and a forge holding `issues` as `[number, author, parent?]`, #1 labelled triage by a maintainer. */
const world = (issues: [number, string, number?][] = [[1, 'morgan']]) => {
  const root = tmp('triage');
  dirs.push(root);
  const seed = join(root, 'seed');
  mkdirSync(seed);
  git(seed, 'init', '-q', '-b', 'main');
  writeFileSync(join(seed, 'README.md'), 'demo\n');
  git(seed, 'add', '-A');
  git(seed, 'commit', '-q', '-m', 'init');
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
  return { origin: join(root, 'origin.git'), forge, data: join(root, 'data'), label };
};

const reply = (...proposals: unknown[]): SessionEvent[] => [
  { type: 'start', session: 's', model: 'test', home: '/homes/s' },
  {
    type: 'end',
    final: `Sized.\n\n\`\`\`bothub\n${JSON.stringify(proposals)}\n\`\`\``,
    ended: 'stop',
    exit: 0,
  },
];

const part = (title: string, size: string, more: object = {}) => ({
  kind: 'issue',
  relation: 'part',
  title,
  body: `Change ${title}.\n\n## Done when\n\n- the tests cover ${title}`,
  size,
  priority: 'medium',
  ...more,
});

const follow = (title: string) => ({
  kind: 'issue',
  relation: 'follow-up',
  title,
  body: `Change ${title}.\n\n## Done when\n\n- it is changed`,
});

const run = <A, E>(
  where: ReturnType<typeof world>,
  turns: SessionEvent[][],
  effect: Effect.Effect<A, E, Forge | Store | Session | Sandbox>
) => {
  const layer = Layer.mergeAll(fileForge(where.forge), fileStore(where.data), host(where.origin), scripted(turns));
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
    const { value } = await run(where, [reply({ kind: 'label', add: ['size/S'] })], tick(hub));
    expect(value.map(r => [r.workflow, r.issue, r.status])).toEqual([['triage', 1, 'done']]);
    expect((await issues(where)).map(t => [t.number, t.labels])).toEqual([[1, ['size/S', 'bothub:done']]]);
  });

  it('does not end done on a comment alone', async () => {
    const where = world();
    where.label(1);
    const { value } = await run(where, Array(3).fill(reply({ kind: 'comment', body: 'small' })), tick(hub));
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

  it('starts runs only on issues in the hub milestone', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    const file = join(where.forge, '1.md');
    writeFileSync(file, readFileSync(file, 'utf8').replace('labels: []', 'labels: []\nmilestone: v1'));
    where.label(1);
    where.label(2);
    const scoped = { ...hub, milestone: 'v1' };
    const first = await run(where, [reply({ kind: 'label', add: ['size/S'] })], tick(scoped));
    expect(first.value.map(r => r.issue)).toEqual([1]);
    const swept = await run(where, [], sweep(scoped));
    expect(swept.value.map(r => r.issue)).toEqual([]);
    const rest = await run(where, [reply({ kind: 'label', add: ['size/S'] })], tick(hub));
    expect(rest.value.map(r => r.issue)).toEqual([2]);
  });

  it('splits an XL issue into stacked children with labels, lines and a task list, and triages the XL child again', async () => {
    const where = world();
    where.label(1);
    const turns = [
      reply(
        { kind: 'label', add: ['size/XL'] },
        { ...part('the parser', 'M'), priority: 'high' },
        part('the printer', 'L', { stacks_on: 1 }),
        part('the docs', 'XL', { stacks_on: 2, depends_on: [1] })
      ),
    ];
    await run(where, turns, tick(unbounded));
    const all = await issues(where);
    const children = all.filter(t => t.parent === 1);
    expect(children.map(t => [t.number, t.title, t.labels])).toEqual([
      [2, 'the parser', ['size/M', 'priority/high']],
      [3, 'the printer', ['size/L', 'priority/medium']],
      [4, 'the docs', ['size/XL', 'priority/medium']],
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
    await run(where, [reply({ kind: 'label', add: ['size/S'] }, follow('Tidy the README'))], tick(unbounded));
    const filed = await issue(where, 2);
    expect([filed.title, filed.parent, filed.labels]).toEqual(['Tidy the README', undefined, ['follow-up']]);
    expect(filed.body).toMatch(/## Done when[\s\S]*\n\nFound while working on #1$/);
    expect((await issue(where, 1)).events.some(m => m.comment?.body.startsWith('Split into'))).toBe(false);

    const bot = Layer.mergeAll(fileForge(where.forge), fileStore(where.data));
    await Effect.runPromise(
      Effect.flatMap(Forge, f =>
        Effect.all([f.apply(2, { kind: 'label', add: ['triage'] }), f.apply(2, { kind: 'comment', body: '/bothub' })])
      ).pipe(Effect.provide(bot))
    );
    expect((await run(where, [], tick(hub))).value).toEqual([]);
    expect((await run(where, [], sweep(hub))).value).toEqual([]);
    expect((await runs(where)).map(r => [r.workflow, r.issue, r.status])).toEqual([['triage', 1, 'done']]);
  });

  it('files a hub change like a follow-up, labelled hub', async () => {
    const where = world();
    where.label(1);
    const hubIssue = { ...follow('Check that new fields are documented'), relation: 'hub' };
    await run(where, [reply({ kind: 'label', add: ['size/S'] }, hubIssue)], tick(unbounded));
    const filed = await issue(where, 2);
    expect([filed.title, filed.parent, filed.labels]).toEqual([
      'Check that new fields are documented',
      undefined,
      ['hub'],
    ]);
    expect(filed.body).toMatch(/\n\nFound while working on #1$/);
    expect((await runs(where)).map(r => r.issue)).toEqual([1]);
  });

  it('refuses a follow-up an open issue already has the title of, and a label that starts a workflow', async () => {
    const where = world();
    where.label(1);
    const dup = await run(where, Array(3).fill(reply(follow('Issue 1'))), tick(unbounded));
    expect(dup.value[0]!.reason).toContain('Issue 1: an open issue has this title');
    const where2 = world();
    where2.label(1);
    const marked = await run(where2, Array(3).fill(reply({ kind: 'label', add: ['size/S', 'triage'] })), tick(hub));
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
    const { value } = await run(where, Array(3).fill(reply(part('a part', 'S'))), tick(unbounded, 4));
    expect(value[0]).toMatchObject({ issue: 4, status: 'waiting' });
    expect(value[0]!.reason).toContain('#4 sits 3 issues deep');
    expect((await issues(where)).map(t => t.number)).toEqual([1, 2, 3, 4]);

    where.label(3);
    await run(where, [reply(part('a big part', 'XL'))], tick(unbounded, 3));
    expect((await issues(where)).filter(t => t.parent === 3).map(t => [t.number, t.labels])).toEqual([
      [4, ['bothub:waiting']],
      [5, ['size/XL', 'priority/medium']],
    ]);
    expect((await runs(where)).some(r => r.issue === 5)).toBe(false);
  });

  it('files nothing from an outsider issue, whatever the agent proposes, and refuses positions that are not earlier', async () => {
    const where = world([
      [1, 'mallory[bot]'],
      [2, 'morgan'],
    ]);
    where.label(1);
    const { value } = await run(where, Array(3).fill(reply(part('spam', 'S'))), tick(hub, 1));
    expect(value[0]!.reason).toContain('#1 is withheld text from an outsider');
    expect((await issue(where, 1)).body).toBe('(issue text by @mallory[bot] withheld: not a collaborator)');

    where.label(2);
    const late = await run(where, Array(3).fill(reply(part('one', 'S', { stacks_on: 1 }))), tick(hub, 2));
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
    const implement = hub.workflows.issue!;
    const waiting = begin(implement, { id: 'issue-2', issue: 2, started: at(5) });
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(waiting)).pipe(Effect.provide(fileStore(where.data))));
    const { value } = await run(where, [], tick(hub, 2, true));
    expect(value).toEqual([]);
    expect((await runs(where)).map(r => [r.id, r.step, r.status, r.tries])).toEqual([
      ['issue-2', 'implement', 'running', 0],
    ]);

    writeFileSync(join(where.forge, '1.md'), '---\ntitle: Issue 1\nstate: closed\nauthor: morgan\n---\n\nDone.\n');
    const after = await run(where, [], tick(hub, 2, true));
    expect(after.value.map(r => [r.id, r.status])).toEqual([['issue-2', 'running']]);
  });

  it('waits on a "Depends on" issue until it is closed, even once it has a pull request', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan'],
    ]);
    appendFileSync(join(where.forge, '2.md'), '\nDepends on #1\n');
    writeFileSync(join(where.forge, '3.md'), '---\ntitle: Fix 1\nstate: open\nauthor: bothub[bot]\n---\n\nCloses #1\n');
    mkdirSync(join(where.forge, '3'), { recursive: true });
    writeFileSync(
      join(where.forge, '3', 'pull.json'),
      JSON.stringify({ branch: 'bothub/1', base: 'main', head: 'abc' })
    );
    const implement = hub.workflows.issue!;
    const waiting = begin(implement, { id: 'issue-2', issue: 2, started: at(5) });
    await Effect.runPromise(Effect.flatMap(Store, s => s.put(waiting)).pipe(Effect.provide(fileStore(where.data))));
    const { value } = await run(where, [], tick(hub, 2, true));
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
    mention(where, '/bothub size this');
    const first = await run(where, [reply({ kind: 'run', workflow: 'triage', issue: 1 })], tick(hub));
    const router = first.value[0]!;
    const [child] = (await runs(where)).filter(r => r.workflow === 'triage');
    expect(child).toMatchObject({ issue: 1, status: 'running', by: router.id });
    expect(router).toMatchObject({ workflow: 'router', status: 'waiting', reason: `waiting on ${child!.id}` });

    await run(where, [reply({ kind: 'label', add: ['size/S'] })], tick(hub));
    expect((await runs(where)).find(r => r.id === child!.id)!.status).toBe('done');
    const last = await run(where, [reply({ kind: 'comment', body: 'Sized S; agent:ready builds it.' })], tick(hub));
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

  it('refuses a run of a workflow without on: dispatch, and a run from an agent that does not return run', async () => {
    const where = world();
    mention(where, '/bothub build this');
    const { value } = await run(where, [reply({ kind: 'run', workflow: 'issue', issue: 1 })], tick(hub));
    expect(value[0]!.reason).toContain('run failed: issue is not a workflow with on: dispatch');

    const other = world();
    other.label(1);
    const tried = await run(
      other,
      Array(3).fill(reply({ kind: 'run', workflow: 'triage', issue: 1 })),
      tick(unbounded)
    );
    expect(tried.value[0]!.reason).toContain('triage may not propose run');
    expect((await runs(other)).map(r => r.workflow)).toEqual(['triage']);
  });
});
