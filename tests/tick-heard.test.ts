import { cpSync, existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { ConfigProvider, Effect } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { readHeard, readHeardOutcome, readIssueWithPull } from '../src/run/hear.ts';
import { readRunSpend } from '../src/run/settle.ts';
import { unmarkedNote } from '../src/workflow.ts';
import { findRequest } from '../src/event.ts';
import type { EventHook } from '../src/plugin.ts';
import { Store } from '../src/store.ts';
import mention from './fixtures/triggers/plugins/mention.ts';
import { reply, start } from './fixtures.ts';
import { git, issuePath, tmp, writeIssueAt } from './kit.ts';
import { world, services, say, comment, makeTestEvent, readTrace } from './world.ts';
import { merging, waiting } from './tick-fixtures.ts';

const issue = merging.workflows.issue;
const hears = (on: Partial<(typeof issue)['on']>) => ({
  ...merging,
  workflows: { issue: { ...issue, on: { ...issue.on, ...on } } },
});
const all = hears({ comment: 'answer' });
const at = (s: number) => `2026-10-16T00:00:0${s}.000Z`;
const open = () => {
  const where = world();
  git(join(where.root, 'seed'), 'push', '-q', where.origin, 'main:agentgraph/7');
  return where;
};
const heardLines = (where: ReturnType<typeof world>) =>
  readTrace(where.data, 'run-7').flatMap(t => ('heard' in t ? [t.heard] : []));
const seen = (run: ReturnType<typeof services>['run']) =>
  run(
    Effect.map(
      Effect.flatMap(Store, s => s.get('run-7')),
      r => [r?.status, r?.seen]
    )
  );

describe('tick on the on: map of a workflow', () => {
  it('wakes a run at merge once on trusted comments without /agent, but not on bot or outsider ones', async () => {
    const where = open();
    say(where, comment(8, 'agentgraph[bot]', false, 'Pushed the fix.', at(3)));
    say(where, comment(8, 'mallory', false, 'rewrite everything', at(4)));
    say(where, comment(8, 'morgan', true, 'rename hello to greet', at(5)));
    say(where, comment(8, 'morgan', true, 'and keep the tests', at(6)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    const touched = await run(Effect.andThen(waiting(where), tick(all, 7)));
    expect(touched.map(r => [r.id, r.step, r.status])).toEqual([['run-7', 'merge', 'waiting']]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('rename hello to greet');
    expect(specs[0]!.prompt).toContain('and keep the tests');
    expect(specs[0]!.prompt).toContain(unmarkedNote);
    expect(specs[0]!.prompt).not.toContain('rewrite everything');
    expect(await run(tick(all, 7))).toEqual([]);
    expect(specs).toHaveLength(1);
  });

  it.each([
    ['leaves it as context', {}, 0],
    ['leaves it as context', { comment: 'none' as const }, 0],
  ])('%s on an unmarked comment when on is %o', async (_, on, sessions) => {
    const where = open();
    say(where, comment(8, 'morgan', true, 'rename hello to greet', at(5)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    await run(Effect.andThen(waiting(where), tick(hears(on), 7)));
    expect(specs).toHaveLength(sessions);
  });

  it('answers a changes-requested review with its line comments when the workflow says so', async () => {
    const where = open();
    const line = { ...comment(8, 'morgan', true, 'rename this', at(4)) };
    say(where, { ...line, comment: { ...line.comment!, path: 'hello.txt', line: 1 } });
    say(
      where,
      makeTestEvent({ issue: 8, kind: 'changes_requested', actor: 'morgan', trusted: true, at: at(5), id: 'r1' })
    );
    const { specs, run } = services(where, [[start('f'), reply()]]);
    await run(Effect.andThen(waiting(where), tick(hears({ changes_requested: 'answer' }), 7)));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('changes requested\nhello.txt:1');
    expect(await run(Effect.flatMap(Store, s => s.get('run-7')))).toMatchObject({ step: 'merge', seen: at(5) });
    expect(readTrace(where.data, 'run-7').find(t => 'outcome' in t)).toMatchObject({ outcome: { kind: 'answer' } });
  });

  it('starts the router on an unmarked comment where a work run is live, and nowhere else', async () => {
    const where = world();
    writeIssueAt(
      issuePath(where.tracker, 9),
      '---\ntitle: Other\nstate: open\nauthor: morgan\nlabels: []\n---\n\nOther.\n'
    );
    const step = { ...issue.steps[0]!, does: { agent: 'router' }, checks: [] };
    const router = { ...issue, name: 'router', on: { issue_comment: {} }, steps: [step] };
    const kit = {
      ...merging,
      workflows: { issue: { ...issue, on: { issues: { label: 'ready' }, comment: 'answer' as const } }, router },
      agents: { ...merging.agents, router: { ...merging.agents.implementor!, returns: ['tell' as const] } },
    };
    say(where, comment(8, 'morgan', true, 'thanks, looks good', at(5)));
    say(where, comment(9, 'morgan', true, 'unrelated note', at(5)));
    const { specs, run } = services(where, [[start('r'), reply()]]);
    await run(waiting(where));
    const touched = await run(tick(kit));
    expect(touched.map(r => [r.workflow, r.issue])).toEqual([['router', 7]]);
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('thanks, looks good');
    expect(specs[0]!.prompt).toContain(unmarkedNote);
    expect(await run(Effect.flatMap(Store, s => s.list({ issue: 9 })))).toEqual([]);
    expect(await run(Effect.flatMap(Store, s => s.get('run-7')))).toMatchObject({ step: 'merge', status: 'waiting' });
  });
});

const source = (name: string, body: string) => `
import { appendFileSync, existsSync } from 'node:fs';
import { Schema } from 'effect';
import { makePlugin } from '@jannik-stacks/agi/plugins';
const settings = Schema.Struct({ log: Schema.String });
export default makePlugin<typeof settings.Type>({
  name: '${name}',
  settingsSchema: settings,
  on: {
    event: ({ event, issue, run, does }, { settings, priceUsd }) => {
      appendFileSync(settings.log, JSON.stringify([event.comment?.body, issue.labels, run.step, does ?? null]) + '\\n');
      ${body}
    },
  },
});
`;
const hooked = (files: Record<string, string>) => {
  const dir = tmp('heard-plugins');
  const log = join(dir, 'log');
  mkdirSync(join(dir, 'plugins'), { recursive: true });
  for (const [name, body] of Object.entries(files))
    writeFileSync(join(dir, 'plugins', `${name}.ts`), source(name, body));
  const calls = () =>
    existsSync(log)
      ? readFileSync(log, 'utf8')
          .trim()
          .split('\n')
          .map(l => JSON.parse(l))
      : [];
  return {
    graph: { ...merging, dir, plugins: Object.fromEntries(Object.keys(files).map(n => [n, { log }])) },
    calls,
    log,
  };
};

describe('tick with an on.event hook', () => {
  it('wakes on the mention plugin, stays on none, and asks it once for each event', async () => {
    const dir = tmp('heard-mention');
    cpSync(join(import.meta.dirname, 'fixtures/triggers/plugins/mention.ts'), join(dir, 'plugins/mention.ts'));
    const graph = { ...merging, dir, plugins: { mention: { words: ['@kit-bot'] } } };
    const where = open();
    say(where, comment(8, 'morgan', true, 'thanks all', at(4)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    await run(Effect.andThen(waiting(where), tick(graph, 7)));
    await run(tick(graph, 7));
    expect(specs).toHaveLength(0);
    expect(heardLines(where)).toEqual([{ event: at(4), plugin: 'mention', does: 'none' }]);
    say(where, comment(8, 'morgan', true, '@kit-bot rename hello to greet', at(5)));
    await run(tick(graph, 7));
    expect(specs).toHaveLength(1);
    expect(specs[0]!.prompt).toContain('rename hello to greet');
    expect(heardLines(where).map(h => h.does)).toEqual(['none', 'answer']);
  });

  it('gives the hook the labels, the run and what the map does, and counts its spend', async () => {
    const { graph, calls } = hooked({ priced: "return { does: 'none', why: 'for a person', usd: 0.25 };" });
    const where = open();
    writeIssueAt(
      issuePath(where.tracker, 7),
      '---\ntitle: Hello\nstate: open\nauthor: morgan\nlabels: [quiet]\n---\n\nHi.\n'
    );
    say(where, comment(8, 'morgan', true, 'rename hello', at(5)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    const withMap = { ...graph, workflows: all.workflows };
    await run(Effect.andThen(waiting(where), tick(withMap, 7)));
    await run(tick(withMap, 7));
    expect(specs).toHaveLength(0);
    expect(calls()).toEqual([['rename hello', ['quiet'], 'merge', 'answer']]);
    expect(heardLines(where)).toEqual([
      { event: at(5), plugin: 'priced', does: 'none', why: 'for a person', usd: 0.25 },
    ]);
    expect(await run(readRunSpend('run-7'))).toEqual({ usd: 0.25 });
  });

  it.each([
    ['a throw', "if (!existsSync(settings.log + '.up')) throw new Error('down'); return 'answer';"],
    ['an unknown word', "return existsSync(settings.log + '.up') ? 'answer' : 'maybe';"],
  ])('leaves the event untaken on %s and asks again on the next pass', async (_, body) => {
    const { graph, calls, log } = hooked({ flaky: body });
    const where = open();
    say(where, comment(8, 'morgan', true, 'rename hello', at(5)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    await run(Effect.andThen(waiting(where), tick(graph, 7)));
    expect([specs.length, heardLines(where), await seen(run)]).toEqual([0, [], ['waiting', undefined]]);
    writeFileSync(`${log}.up`, '');
    await run(tick(graph, 7));
    expect([specs.length, calls().length]).toEqual([1, 2]);
  });

  it('keeps a later comment waiting behind a failed hook, but still hears a stop', async () => {
    const { graph, calls } = hooked({
      picky: "if (event.comment?.body === 'first') throw new Error('down'); return 'answer';",
    });
    const where = open();
    say(where, comment(8, 'morgan', true, 'first', at(4)));
    say(where, comment(8, 'morgan', true, 'second', at(5)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    await run(Effect.andThen(waiting(where), tick(graph, 7)));
    expect([specs.length, await seen(run)]).toEqual([0, ['waiting', undefined]]);
    expect(calls().map(c => c[0])).toEqual(['first']);
    say(where, comment(8, 'morgan', true, '/agent:stop', at(6)));
    await run(tick(graph, 7));
    expect((await seen(run))[0]).toBe('stopped');
  });

  it('keeps the charge of a hook that ran before a failed one, and asks only the failed one again', async () => {
    const { graph, calls, log } = hooked({
      paid: "return { does: 'none', usd: 0.25 };",
      flaky: "if (!existsSync(settings.log + '.up')) throw new Error('down'); return { does: 'answer', usd: 0.5 };",
    });
    const where = open();
    say(where, comment(8, 'morgan', true, 'rename hello', at(5)));
    const { specs, run } = services(where, [[start('f'), reply()]]);
    await run(Effect.andThen(waiting(where), tick(graph, 7)));
    expect([specs.length, await seen(run)]).toEqual([0, ['waiting', undefined]]);
    expect(heardLines(where)).toEqual([{ event: at(5), plugin: 'paid', does: 'none', usd: 0.25 }]);
    expect(await run(readRunSpend('run-7'))).toEqual({ usd: 0.25 });
    writeFileSync(`${log}.up`, '');
    await run(tick(graph, 7));
    expect(calls().map(c => c[3])).toEqual([null, 'none', 'none']);
    expect(heardLines(where)).toEqual([
      { event: at(5), plugin: 'paid', does: 'none', usd: 0.25 },
      { event: at(5), plugin: 'flaky', does: 'answer', usd: 0.5 },
    ]);
    expect(specs).toHaveLength(1);
  });

  it('lets the last hook in settings order win, and keeps what the map does where pass does not apply', async () => {
    const { graph, calls } = hooked({ b: "return 'answer';", a: "return 'pass';" });
    const where = world();
    const asked = {
      ...(await services(where, []).run(
        Effect.andThen(
          waiting(where),
          Effect.flatMap(Store, s => s.get('run-7'))
        )
      ))!,
      step: 'implement',
    };
    const m = comment(7, 'morgan', true, 'rename hello', at(5));
    const { run } = services(where, []);
    const { hooked: said } = await run(readHeard(graph, issue, asked, [m]));
    expect(calls().map(c => c[3])).toEqual([null, 'answer']);
    expect([...said]).toEqual([[m.id, 'answer']]);
    expect(heardLines(where)).toEqual([
      { event: m.id, plugin: 'b', does: 'answer' },
      { event: m.id, plugin: 'a', does: 'pass' },
    ]);
  });

  it.each(['pass', 'back'] as const)('applies a %s said off a human wait once the run waits on a human', async does => {
    const { graph, calls } = hooked({ late: `return '${does}';` });
    const where = world();
    const { run } = services(where, []);
    const stored = (await run(
      Effect.andThen(
        waiting(where),
        Effect.flatMap(Store, s => s.get('run-7'))
      )
    ))!;
    const m = comment(7, 'morgan', true, 'rename hello', at(5));
    const early = await run(readHeard(graph, issue, { ...stored, step: 'implement' }, [m]));
    const late = await run(readHeard(graph, issue, stored, [m]));
    expect([[...early.hooked], [...late.hooked], calls().length]).toEqual([[], [[m.id, does]], 1]);
  });

  it('passes a run at a human wait on the pass its hook said before the wait', async () => {
    const { graph, calls } = hooked({ late: "return 'pass';" });
    const where = world();
    say(where, comment(8, 'morgan', true, 'ship it', at(5)));
    const { run } = services(where, []);
    const stored = (await run(
      Effect.andThen(
        waiting(where),
        Effect.flatMap(Store, s => s.get('run-7'))
      )
    ))!;
    const hear = (r: typeof stored) =>
      run(Effect.flatMap(readIssueWithPull(issue, r, graph), t => readHeardOutcome(graph, issue, r, t)));
    const early = await hear({ ...stored, step: 'implement' });
    const late = await hear(stored);
    expect([early, late?.outcome, calls().length]).toEqual([undefined, { kind: 'pass' }, 1]);
  });

  it('prices a hook call with the instance price table', async () => {
    const { graph } = hooked({ priced: "return { does: 'none', usd: priceUsd('m-test', { input: 3 }) };" });
    const table = join(tmp('heard-prices'), 'prices.json');
    writeFileSync(table, JSON.stringify({ 'acme/m-test': { input_cost_per_token: 2, output_cost_per_token: 1 } }));
    const where = world();
    const { run } = services(where, []);
    const stored = (await run(
      Effect.andThen(
        waiting(where),
        Effect.flatMap(Store, s => s.get('run-7'))
      )
    ))!;
    const m = comment(7, 'morgan', true, 'rename hello', at(5));
    await run(
      readHeard(graph, issue, stored, [m]).pipe(
        Effect.provideService(
          ConfigProvider.ConfigProvider,
          ConfigProvider.fromEnv({ env: { AGENTGRAPH_PRICES: table } })
        )
      )
    );
    expect(heardLines(where)).toEqual([{ event: m.id, plugin: 'priced', does: 'none', usd: 6 }]);
  });

  it('skips hooks for commands, bots, tells of other kinds and a run paused on limits', async () => {
    const { graph, calls } = hooked({ any: "return 'answer';" });
    const where = world();
    const { run } = services(where, []);
    const stored = (await run(
      Effect.andThen(
        waiting(where),
        Effect.flatMap(Store, s => s.get('run-7'))
      )
    ))!;
    const plain = comment(7, 'morgan', true, 'rename hello', at(5));
    const skipped = [
      {
        ...comment(7, 'morgan', true, '/agent:stop', at(5)),
        comment: {
          id: 'c',
          author: 'morgan',
          body: '/agent:stop',
          at: at(5),
          agentRequest: findRequest('/agent:stop')!,
        },
      },
      { ...plain, bot: true },
      { ...plain, trusted: false },
      makeTestEvent({ issue: 7, kind: 'label', actor: 'morgan', trusted: true, at: at(5), label: 'approved' }),
    ];
    await run(readHeard(graph, issue, stored, skipped));
    await run(readHeard(graph, issue, { ...stored, waiting: { on: 'limits', why: 'over' } }, [plain]));
    expect(calls()).toEqual([]);
  });
});

const heardBy = (body: string, more = {}) => ({
  event: { ...comment(7, 'morgan', true, body, at(5)), ...more },
  issue: { number: 7, labels: [], author: 'morgan' },
  run: { id: 'run-7', workflow: 'issue', step: 'merge', status: 'waiting' as const },
});

describe('the mention plugin', () => {
  const context = {
    repo: 'acme/app',
    settings: { words: ['@kit-bot'] },
    tracker: { searchIssues: async () => [] },
    signal: new AbortController().signal,
    priceUsd: () => undefined,
  } satisfies Parameters<EventHook<{ words: string[] }>>[1];
  it.each([
    ['@kit-bot rename it', {}, 'answer'],
    ['thanks all', {}, 'none'],
    ['> @kit-bot rename it', {}, 'none'],
    ['merged', { kind: 'merged' }, undefined],
  ])('hears %s as %s', (body, more, does) => {
    expect(mention.on!.event!(heardBy(body, more), context)).toBe(does);
  });
});
