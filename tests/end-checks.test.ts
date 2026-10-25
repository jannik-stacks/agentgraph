import { execFileSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Either } from 'effect';
import { describe, expect, it } from 'vitest';
import { drive, instruct, runStepChecks, scanIssuesAndRunningRuns, tick } from '../src/engine.ts';
import type { Check, Hub } from '../src/hub.ts';
import { Store } from '../src/store.ts';
import type { SessionEvent } from '../src/trace.ts';
import { transition, type Run } from '../src/workflow.ts';
import { reply, start, wrote } from './fixtures.ts';
import { fresh, hub, judged, pull, push, say, services, traceOf, w, world } from './world.ts';

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

const keep = (where: ReturnType<typeof world>) => {
  const git = (...args: string[]) =>
    execFileSync('git', ['--git-dir', where.origin, ...args])
      .toString()
      .trim();
  git('update-ref', 'refs/agentgraph/runs/run-7', git('commit-tree', 'main^{tree}', '-p', 'main', '-m', 'kept'));
};

const results = (data: string, id = 'run-7') =>
  traceOf(data, id).flatMap(t => ('check' in t && t.item === undefined ? [{ ...t.check, end: t.end }] : []));

const verdict = (text: string): SessionEvent[] => [start('j'), { type: 'text', text }];

describe('a check that returns a number', () => {
  it('takes the last line a script prints, and is empty without a number there', async () => {
    const where = world();
    const h = ending({
      share: { returns: 'number', run: 'echo measuring; echo 0.7' },
      hours: { returns: 'number', run: 'echo 26; exit 1' },
      words: { returns: 'number', run: 'echo done' },
      blank: { returns: 'number', run: 'true' },
      hex: { returns: 'number', run: 'echo 0x10' },
    });
    const step = {
      name: 'implement',
      does: { agent: 'implementor' },
      checks: Object.keys(h.workflows.issue!.checks),
      tries: 1,
    };
    const { run } = services(where, []);
    const { outcome } = await run(runStepChecks({ ...step, checks: h.workflows.issue!.checks }, left(where), h));
    expect(outcome).toEqual({ kind: 'pass' });
    const by = Object.fromEntries(results(where.data).map(r => [r.check, r]));
    expect(by.share).toMatchObject({ pass: true, value: 0.7 });
    expect(by.share).not.toHaveProperty('empty');
    expect(by.hours).toMatchObject({ pass: false, value: 26 });
    const unmeasured = ['words', 'blank', 'hex'].map(name => by[name]);
    expect(unmeasured).toEqual(
      unmeasured.map(() => expect.objectContaining({ empty: true, findings: 'Its output ends in no number.' }))
    );
    expect(unmeasured.filter(r => r && 'value' in r)).toEqual([]);
  });

  it('gives the share of items its judge passed, a real 0 when it fails them all, and empty when nothing was judged', async () => {
    const where = world();
    const h = ending({
      most: { returns: 'number', each: 'seq 4', agent: 'claim-checker' },
      none: { returns: 'number', each: 'true', agent: 'claim-checker' },
    });
    const turns = [verdict('PASS'), verdict('PASS'), verdict('FAIL, wrong'), verdict('PASS')];
    const { run } = services(where, turns);
    const step = { name: 'implement', does: { agent: 'implementor' }, checks: ['most', 'none'], tries: 1 };
    await run(runStepChecks(step, left(where), h));
    const by = Object.fromEntries(results(where.data).map(r => [r.check, r]));
    expect(by.most).toMatchObject({ pass: false, value: 0.75 });
    expect(by.none).toMatchObject({ pass: true, empty: true });
    expect(by.none).not.toHaveProperty('value');

    const zero = world();
    const all = services(zero, [verdict('FAIL, no'), verdict('FAIL, no')]);
    await all.run(
      runStepChecks({ ...step, checks: ['most'] }, left(zero), {
        ...h,
        checks: { ...h.checks, most: { ...h.checks.most!, each: 'seq 2' } },
      })
    );
    expect(results(zero.data)[0]).toMatchObject({ pass: false, value: 0 });
  });

  it('is empty, never a share, when a judge gives no verdict on an item', async () => {
    const where = world();
    const h = ending({ most: { returns: 'number', each: 'seq 2', agent: 'claim-checker' } });
    const { run } = services(where, [verdict('PASS'), verdict('maybe'), verdict('maybe')]);
    const step = { name: 'implement', does: { agent: 'implementor' }, checks: ['most'], tries: 1 };
    await run(runStepChecks(step, left(where), h));
    const [result] = results(where.data);
    expect(result).toMatchObject({ pass: false, empty: true });
    expect(result).not.toHaveProperty('value');
  });
});

describe('end checks', () => {
  it('owe the workflow checks from the move that ends a run', () => {
    const h = ending({ lines: { returns: 'number', run: 'echo 1' } });
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
      present: { run: 'test -e hello.txt' },
      lines: { returns: 'number', run: 'wc -l < hello.txt' },
      changed: { returns: 'number', each: 'files', run: 'test -s "$AGENTGRAPH_ITEM"' },
    });
    const flow = h.workflows.issue!;
    const first = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(await first.run(drive(flow, fresh(), h))).toMatchObject({ step: 'merge', status: 'waiting' });
    const at = '2026-10-16T00:10:00.000Z';
    for (const n of [7, 8]) {
      const file = join(where.forge, `${n}.md`);
      writeFileSync(file, readFileSync(file, 'utf8').replace('state: open', `state: ${n === 7 ? 'closed' : 'merged'}`));
    }
    say(where, { issue: 7, kind: 'closed', actor: 'morgan', trusted: true, at });
    say(where, { issue: 8, kind: 'merged', actor: 'morgan', trusted: true, at });
    const second = services(where, []);
    const swept = await second.run(scanIssuesAndRunningRuns(h));
    expect(swept.map(r => [r.id, r.status, r.owed])).toEqual([['run-7', 'done', undefined]]);
    const ends = results(where.data).filter(r => r.end);
    expect(ends).toEqual([
      expect.objectContaining({ check: 'present', pass: true }),
      expect.objectContaining({ check: 'lines', pass: true, value: 1 }),
      expect.objectContaining({ check: 'changed', pass: true, value: 1 }),
    ]);
  });

  it('run only what a killed pass left owed, and nothing on the next look', async () => {
    const where = world();
    const h = ending({ present: { run: 'echo present' }, lines: { returns: 'number', run: 'echo 3' } });
    const { commands, run } = services(where, []);
    keep(where);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done', step: 'merge', owed: ['lines'] })));
    await run(tick(h, 7, true));
    await run(tick(h, 7, true));
    expect(commands.filter(c => c.args.some(a => a.startsWith('echo'))).map(c => c.args.at(-1))).toEqual(['echo 3']);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ status: 'done' });
    expect(stored).not.toHaveProperty('owed');
    expect(results(where.data)).toEqual([expect.objectContaining({ check: 'lines', value: 3, end: true })]);
  });

  it('give a check gone from the hub, or a run without kept files, an empty result naming why', async () => {
    const where = world();
    const h = ending({ lines: { returns: 'number', run: 'echo 3' } });
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

  it('run again later on stored runs that ended, and refuse a check the hub lacks', async () => {
    const where = world();
    const h = ending({ lines: { returns: 'number', run: 'echo 5' } });
    const { run } = services(where, []);
    keep(where);
    await run(Effect.flatMap(Store, s => s.put({ ...fresh(), status: 'done', step: 'merge' })));
    const [after] = await run(instruct(h, { kind: 'check', checks: ['lines'], issue: 7 }));
    expect(after).toMatchObject({ status: 'done' });
    expect(after).not.toHaveProperty('owed');
    expect(results(where.data)).toEqual([expect.objectContaining({ check: 'lines', value: 5, end: true })]);
    const refused = await run(Effect.either(instruct(h, { kind: 'check', checks: ['nope'] })));
    expect(Either.isLeft(refused) && refused.left.message).toBe('the hub has no check nope');
  });
});
