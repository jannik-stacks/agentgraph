import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { instruct, runStepChecks, scanIssuesAndRunningRuns, tick } from '../src/engine.ts';
import type { Check, Hub } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { transition, type Run } from '../src/workflow.ts';
import { result, start } from './fixtures.ts';
import { fresh, hub, pullRequest, say, services, readTrace, w, world } from './world.ts';

const ending = (checks: Record<string, Partial<Check>>): Hub => ({
  ...hub,
  checks: {
    ...hub.checks,
    ...Object.fromEntries(
      Object.entries(checks).map(([name, c]) => [
        name,
        { name, path: `checks/${name}.md`, body: '', mode: 'warn', ...c },
      ])
    ),
  },
  workflows: { issue: { ...w, checks: Object.keys(checks) } },
});

const left = (where: ReturnType<typeof world>) => {
  const dir = join(where.root, 'work');
  mkdirSync(dir);
  mkdirSync(join(where.root, 'news'));
  return {
    run: 'run-7',
    issue: 7,
    context: '',
    reply: '',
    dir,
    base: 'HEAD',
    git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
    news: join(where.root, 'news', 'news.md'),
    proposals: [],
  };
};

const git = (where: ReturnType<typeof world>, ...args: string[]) =>
  execFileSync('git', ['--git-dir', where.origin, ...args], {
    env: { ...process.env, GIT_INDEX_FILE: join(where.root, 'index') },
  })
    .toString()
    .trim();

const keep = (where: ReturnType<typeof world>, branch?: string) => {
  const startCommit = git(where, 'rev-parse', 'main');
  git(where, 'read-tree', 'main');
  if (branch) {
    const blob = execFileSync('git', ['--git-dir', where.origin, 'hash-object', '-w', '--stdin'], { input: 'hello\n' });
    git(where, 'update-index', '--add', '--cacheinfo', `100644,${blob.toString().trim()},hello.txt`);
  }
  const tree = git(where, 'write-tree');
  const tip = branch ? git(where, 'commit-tree', tree, '-p', startCommit, '-m', 'Add hello') : startCommit;
  if (branch) git(where, 'update-ref', `refs/heads/${branch}`, tip);
  git(where, 'update-ref', 'refs/agentgraph/runs/run-7', git(where, 'commit-tree', tree, '-p', tip, '-m', 'kept'));
  return startCommit;
};

const results = (data: string, id = 'run-7') =>
  readTrace(data, id).flatMap(t => ('check' in t && t.item === undefined ? [{ ...t.check, end: t.end }] : []));

const judge = (pass: boolean, why = pass ? 'fine' : 'wrong'): SessionEvent[] => [start('j'), result({ pass, why })];
const silent: SessionEvent[] = [start('j'), { type: 'text', text: 'maybe' }];
const count = { type: 'object', required: ['n'], properties: { n: { type: 'number' } } } as const;
const measure = (command: string) => ({
  mode: 'info' as const,
  returns: count,
  run: `echo "{\\"n\\": $(${command})}"`,
});
const implement = (...checks: string[]) => ({ name: 'implement', does: { agent: 'implementor' }, checks, tries: 1 });

describe('a check result', () => {
  it('is the exit and output of a plain script, and the JSON object a script with its own returns prints last', async () => {
    const where = world();
    const h = ending({
      plain: { run: 'echo fine' },
      failing: { run: 'echo broken; exit 1' },
      counted: { mode: 'info', returns: count, run: 'echo measuring; echo \'{"n": 3, "why": "three"}\'' },
      text: { mode: 'info', returns: count, run: 'echo 3' },
      broken: { mode: 'info', returns: count, run: 'echo "{n: 3"' },
      exited: { returns: count, pass: { properties: { n: { minimum: 0 } } }, run: 'echo \'{"n": 3}\'; exit 1' },
    });
    const { run } = services(where, []);
    await run(runStepChecks(implement('plain', 'failing', 'counted', 'text', 'broken', 'exited'), left(where), h));
    const by = Object.fromEntries(results(where.data).map(r => [r.check, r]));
    expect(by.plain).toMatchObject({ pass: true });
    expect(by.plain).not.toHaveProperty('value');
    expect(by.failing).toMatchObject({ pass: false, findings: 'broken' });
    expect(by.counted).toMatchObject({ pass: true, value: { n: 3 } });
    expect(by.counted).not.toHaveProperty('empty');
    expect(by.text).toMatchObject({ pass: true, empty: true, findings: 'unreadable: its last line is no JSON object' });
    expect(by.broken).toMatchObject({ pass: true, empty: true, findings: expect.stringContaining('no JSON object') });
    expect(by.exited).toMatchObject({ pass: false, value: { n: 3 }, findings: 'exit 1' });
  });

  it('passes when it matches pass, so a threshold fails a valid result', async () => {
    const where = world();
    const cheap = { properties: { n: { maximum: 2 } } };
    const h = ending({
      under: { returns: count, pass: cheap, run: 'echo \'{"n": 1}\'' },
      over: { returns: count, pass: cheap, run: 'echo \'{"n": 5, "why": "five calls"}\'' },
    });
    const { run } = services(where, []);
    await run(runStepChecks(implement('under', 'over'), left(where), h));
    const by = Object.fromEntries(results(where.data).map(r => [r.check, r]));
    expect(by.under).toMatchObject({ pass: true, value: { n: 1 } });
    expect(by.over).toMatchObject({ pass: false, value: { n: 5 }, findings: 'result.n must be at most 2\nfive calls' });
  });

  it('gives a judge the result tool typed by returns, and keeps the value it records', async () => {
    const where = world();
    const h = ending({ wasted: { mode: 'info', returns: count, agent: 'claim-checker' } });
    const { run, specs } = services(where, [[start('j'), result({ n: 2, why: 'two redid work' })]]);
    await run(runStepChecks(implement('wasted'), left(where), h));
    expect(results(where.data)[0]).toMatchObject({ pass: true, value: { n: 2 } });
    expect(specs[0]).toMatchObject({ returns: count });
    expect(specs[0]?.prompt).toContain('Call the result tool');
  });
});

describe('a check with items', () => {
  it('gives the share of items that passed, a real 0 when all fail, and empty when there were none', async () => {
    const where = world();
    const h = ending({
      most: { each: 'seq 4', agent: 'claim-checker' },
      none: { each: 'true', agent: 'claim-checker' },
    });
    const { run } = services(where, [judge(true), judge(true), judge(false), judge(true)]);
    await run(runStepChecks(implement('most', 'none'), left(where), h));
    const by = Object.fromEntries(results(where.data).map(r => [r.check, r]));
    expect(by.most).toMatchObject({ pass: false, share: 0.75 });
    expect(by.none).toMatchObject({ pass: true, empty: true });
    expect(by.none).not.toHaveProperty('share');

    const zero = world();
    const all = services(zero, [judge(false), judge(false)]);
    await all.run(
      runStepChecks(implement('most'), left(zero), {
        ...h,
        checks: { ...h.checks, most: { ...h.checks.most!, each: 'seq 2' } },
      })
    );
    expect(results(zero.data)[0]).toMatchObject({ pass: false, share: 0 });
  });

  it('applies pass to each item and keeps item values on the item lines', async () => {
    const where = world();
    const h = ending({
      sizes: {
        returns: count,
        pass: { properties: { n: { maximum: 2 } } },
        each: 'seq 3',
        run: 'echo "{\\"n\\": $AGENTGRAPH_ITEM}"',
      },
    });
    const { run } = services(where, []);
    await run(runStepChecks(implement('sizes'), left(where), h));
    const items = readTrace(where.data, 'run-7').flatMap(t => ('check' in t && t.item ? [t.check] : []));
    expect(items.map(i => [i.pass, i.value])).toEqual([
      [true, { n: 1 }],
      [true, { n: 2 }],
      [false, { n: 3 }],
    ]);
    expect(results(where.data)[0]).toMatchObject({ pass: false, share: 2 / 3 });
  });

  it('gives no share and fails when a judge gives no result on an item', async () => {
    const where = world();
    const h = ending({ most: { each: 'seq 2', agent: 'claim-checker' } });
    const { run } = services(where, [judge(true), silent, silent]);
    await run(runStepChecks(implement('most'), left(where), h));
    const [result] = results(where.data);
    expect(result).toMatchObject({
      pass: false,
      empty: true,
      findings: expect.stringContaining('could not be judged'),
    });
    expect(result).not.toHaveProperty('share');
  });
});

describe('a judge', () => {
  const step = {
    name: 'implement',
    does: { agent: 'implementor' },
    checks: ['claims'],
    tries: 1,
  };
  const h = ending({ claims: { agent: 'claim-checker' } });

  it('decides with the result tool, its why as the findings, and its last valid call counts', async () => {
    const where = world();
    const { run, specs } = services(where, [
      [
        start('j'),
        result({ pass: true, why: 'fine' }),
        {
          type: 'tool',
          id: 'v2',
          name: 'agentgraph_result',
          input: { pass: false, why: 'off by one' },
          ok: true,
        },
        result({ pass: 'yes', why: 'bad' }),
      ],
    ]);
    await run(runStepChecks(step, left(where), h));
    expect(results(where.data)[0]).toMatchObject({
      check: 'claims',
      pass: false,
      findings: 'off by one',
    });
    expect(specs[0]).toMatchObject({ returns: { required: ['pass'] } });
    expect(specs[0]?.prompt).toContain('Call the result tool');
  });

  it('is resumed once and told to call the tool when it stops without a result', async () => {
    const where = world();
    const { run, specs } = services(where, [silent, [result({ pass: true, why: 'fine' })]]);
    await run(runStepChecks(step, left(where), h));
    expect(results(where.data)[0]).toMatchObject({
      check: 'claims',
      pass: true,
    });
    expect(specs[1]).toMatchObject({
      resume: { id: 'j', home: '/homes/j' },
      check: 'claims',
    });
    expect(specs[1]?.prompt).toMatch(/^You ended without calling the result tool/);
  });

  it('starts fresh, not resumed, when a session fails even after recording a result', async () => {
    const where = world();
    const failed: SessionEvent[] = [
      start('j'),
      result({ pass: true, why: 'fine' }),
      { type: 'end', final: '', ended: 'error', exit: 1 },
    ];
    const { run, specs } = services(where, [failed, judge(false, 'off by one')]);
    await run(runStepChecks(step, left(where), h));
    expect(specs.map(s => s.resume)).toEqual([undefined, undefined]);
    expect(results(where.data)[0]).toMatchObject({
      pass: false,
      findings: 'off by one',
    });
  });

  it('reads this run trace, written beside the news file', async () => {
    const where = world();
    const traced = ending({
      lines: measure('wc -l < $AGENTGRAPH_RUN_TRACE'),
    });
    const { run } = services(where, []);
    await run(runStepChecks({ ...step, checks: ['lines'] }, left(where), traced));
    expect(results(where.data)[0]).toMatchObject({
      pass: true,
      value: { n: expect.any(Number) },
    });
  });

  it('could not be judged when the resumed session still gives none, counting a refused call as none', async () => {
    const where = world();
    const refused: SessionEvent = {
      type: 'tool',
      id: 'v',
      name: 'mcp__agentgraph__result',
      input: { pass: true, why: 'fine' },
      ok: false,
    };
    const { run, specs } = services(where, [[start('j'), refused], silent]);
    await run(runStepChecks(step, left(where), h));
    expect(specs).toHaveLength(2);
    expect(results(where.data)[0]).toMatchObject({
      pass: false,
      findings: expect.stringContaining('could not be judged'),
    });
  });
});

describe('end checks', () => {
  it('owe the workflow checks from the move that ends a run', () => {
    const h = ending({ lines: measure('echo 1') });
    const running: Run = { ...fresh(), step: 'review', status: 'running' };
    expect(transition(h.workflows.issue!, running, { kind: 'stop', why: 'no' }).owed).toEqual(['lines']);
    const waiting: Run = { ...fresh(), step: 'merge', status: 'waiting' };
    expect(transition(h.workflows.issue!, waiting, { kind: 'pass' })).toMatchObject({
      status: 'done',
      owed: ['lines'],
    });
    expect(transition(w, waiting, { kind: 'pass' })).not.toHaveProperty('owed');
  });

  it('run once a merge ends the run, on its kept files, and leave its status alone', async () => {
    const where = world();
    const h = ending({
      lines: measure('wc -l < hello.txt'),
      changed: { each: 'files', run: 'test -s "$AGENTGRAPH_ITEM"' },
    });
    const startCommit = keep(where, 'agentgraph/7');
    const kept = git(where, 'rev-parse', 'refs/agentgraph/runs/run-7');
    pullRequest(where);
    const { run } = services(where, []);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), step: 'merge', status: 'waiting', startCommit })));
    const at = '2026-10-16T00:10:00.000Z';
    for (const n of [7, 8]) {
      const file = join(where.forge, `${n}.md`);
      writeFileSync(file, readFileSync(file, 'utf8').replace('state: open', `state: ${n === 7 ? 'closed' : 'merged'}`));
    }
    say(where, { issue: 7, kind: 'closed', actor: 'morgan', trusted: true, at });
    say(where, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at });
    git(where, 'update-ref', 'refs/heads/main', 'refs/heads/agentgraph/7');
    const swept = await run(scanIssuesAndRunningRuns(h));
    expect(swept.map(r => [r.id, r.status, r.owed])).toEqual([['run-7', 'done', undefined]]);
    const ends = results(where.data).filter(r => r.end);
    expect(ends).toEqual([
      expect.objectContaining({ check: 'lines', pass: true, value: { n: 1 } }),
      expect.objectContaining({ check: 'changed', pass: true, share: 1 }),
    ]);
    expect(git(where, 'rev-parse', 'refs/agentgraph/runs/run-7')).toBe(kept);
  });

  it('run only what a killed pass left owed, and nothing on the next look', async () => {
    const where = world();
    const h = ending({ present: { run: 'echo present' }, lines: measure('echo 3') });
    const { commands, run } = services(where, []);
    const startCommit = keep(where);
    await run(
      Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done', step: 'merge', owed: ['lines'], startCommit }))
    );
    await run(tick(h, 7, true));
    await run(tick(h, 7, true));
    expect(commands.filter(c => c.args.some(a => a.startsWith('echo'))).map(c => c.args.at(-1))).toEqual([
      measure('echo 3').run,
    ]);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ status: 'done' });
    expect(stored).not.toHaveProperty('owed');
    expect(results(where.data)).toEqual([expect.objectContaining({ check: 'lines', value: { n: 3 }, end: true })]);
  });

  it('give a check gone from the hub, or a run without kept files, an empty result naming why', async () => {
    const where = world();
    const h = ending({ lines: measure('echo 3') });
    const { run } = services(where, []);
    await run(
      Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'stopped', step: 'merge', owed: ['gone', 'lines'] }))
    );
    await run(tick(h, 7, true));
    expect(results(where.data)).toEqual([
      expect.objectContaining({
        check: 'gone',
        pass: false,
        empty: true,
        findings: 'the hub has no check gone',
        end: true,
      }),
      expect.objectContaining({
        check: 'lines',
        empty: true,
        findings: expect.stringContaining('refs/agentgraph/runs/run-7'),
      }),
    ]);
  });

  it('run again later on stored runs that ended, each on the files setup left, and refuse a check the hub lacks', async () => {
    const where = world();
    const h = ending({ wipe: { run: 'rm README.md' }, lines: measure('wc -l < README.md') });
    const { run } = services(where, []);
    const startCommit = keep(where);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done', step: 'merge', startCommit })));
    const [after] = await run(instruct(h, { kind: 'check', checks: ['wipe', 'lines'], issue: 7 }));
    expect(after).toMatchObject({ status: 'done' });
    expect(after).not.toHaveProperty('owed');
    expect(results(where.data)).toEqual([
      expect.objectContaining({ check: 'wipe', pass: true, end: true }),
      expect.objectContaining({ check: 'lines', value: { n: 1 }, end: true }),
    ]);
    const refused = await run(Effect.either(instruct(h, { kind: 'check', checks: ['nope'] })));
    expect(Either.isLeft(refused) && refused.left.message).toBe('the hub has no check nope');
  });

  it('run checks that read only traces on the target branch when the run kept no files or start commit', async () => {
    const where = world();
    const h = ending({ lines: { ...measure('wc -l < $AGENTGRAPH_RUN_TRACE'), reads: 'traces' } });
    const { run } = services(where, []);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done', step: 'merge' })));
    await run(instruct(h, { kind: 'check', checks: ['lines'] }));
    expect(results(where.data)).toEqual([
      expect.objectContaining({ check: 'lines', pass: true, value: { n: expect.any(Number) }, end: true }),
    ]);
  });
});
