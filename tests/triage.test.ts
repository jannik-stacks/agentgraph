import { appendFileSync, mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Layer } from 'effect';
import { afterEach, describe, expect, it } from 'vitest';
import { tick } from '../src/engine.ts';
import { fileForge, Forge, type Event } from '../src/forge.ts';
import { loadHub } from '../src/hub.ts';
import { host, type Sandbox } from '../src/sandbox.ts';
import { scripted, type Session, type SessionEvent } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import { begin } from '../src/workflow.ts';
import { git, tmp } from './fixtures.ts';

const hub = await Effect.runPromise(loadHub(join(import.meta.dirname, '..', 'examples', 'sandbox')));

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
  title,
  body: `Change ${title}.\n\n## Done when\n\n- the tests cover ${title}`,
  size,
  priority: 'medium',
  ...more,
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
    await run(where, turns, tick(hub));
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

  it('files no children from an issue three levels deep, and begins no triage on an XL child at the cap', async () => {
    const where = world([
      [1, 'morgan'],
      [2, 'morgan', 1],
      [3, 'morgan', 2],
      [4, 'morgan', 3],
    ]);
    where.label(4);
    const { value } = await run(where, Array(3).fill(reply(part('a part', 'S'))), tick(hub, 4));
    expect(value[0]).toMatchObject({ issue: 4, status: 'waiting' });
    expect(value[0]!.reason).toContain('#4 sits 3 issues deep');
    expect((await issues(where)).map(t => t.number)).toEqual([1, 2, 3, 4]);

    where.label(3);
    await run(where, [reply(part('a big part', 'XL'))], tick(hub, 3));
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
    expect(after.value.map(r => [r.id, r.status])).toEqual([['issue-2', 'stopped']]);
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
