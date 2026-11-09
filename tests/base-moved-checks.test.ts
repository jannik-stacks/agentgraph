import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { gunzipSync } from 'node:zlib';
import { Effect, Exit, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { tick } from '../src/run/trigger.ts';
import { findIssueNumbers, Tracker } from '../src/tracker.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent, SessionSpec, Trace } from '../src/trace.ts';
import type { Graph } from '../src/folder.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { makeTestGraph, reply, result, start, stop, wrote } from './fixtures.ts';
import { git, issuePath } from './kit.ts';
import { graph, w, world, push, pull, judged, services, readChecks, say, comment } from './world.ts';
import { runStepChecks } from '../src/run/check.ts';

import { parked, moved, behind, rebases, merging } from './base-moved-fixtures.ts';
const readJudgeSessions = (data: string) =>
  readChecks(data, 'run-7').flatMap(e =>
    e.log
      ? gunzipSync(readFileSync(join(data, 'logs', `${e.log.hash}.gz`)))
          .toString('utf8')
          .split('\n')
          .filter(Boolean)
          .flatMap(line => {
            const t = JSON.parse(line) as Trace;
            return 'session' in t ? [t.session] : [];
          })
      : []
  );

describe('a base that moved', () => {
  const said = (where: ReturnType<typeof world>) =>
    findIssueNumbers(where.tracker)
      .map(n => readFileSync(issuePath(where.tracker, n, 'events.jsonl'), 'utf8'))
      .join('');
  it('judges after the script checks pass when the step names a judged check, and only then', async () => {
    const where = await moved('other.txt');
    const { specs, run } = services(where, [judged]);
    await run(tick(merging({ checks: ['types', 'claims'] })));
    expect(specs).toHaveLength(1);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });

    const red = await moved('other.txt');
    const failing = services(red, [[start('i2'), reply({ kind: 'ask', question: 'Why red?' })]]);
    const strict = { ...graph, checks: { ...graph.checks, types: { ...graph.checks.types!, run: 'exit 1' } } };
    await failing.run(tick(merging({ checks: ['types', 'claims'] }, strict)));
    expect(failing.specs.map(s => s.prompt)[0]).toMatch(/^the merge step sent this back: types/);
  });

  it.each([
    ['runs the setup before the checks', 'touch .ready', 'test -e .ready'],
    ['takes a check whose command is missing as infrastructure, not a red change', undefined, 'not-installed-tool'],
  ])('%s and keeps the run waiting', async (_, setup, script) => {
    const where = await moved('other.txt');
    const { specs, run } = services(where, []);
    const checked = {
      ...graph,
      ...(setup && { setup }),
      checks: { ...graph.checks, types: { ...graph.checks.types!, run: script } },
    };
    await run(tick(merging({ checks: ['types'] }, checked)));
    expect(behind(where)).toBe('0');
    expect(specs).toHaveLength(0);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
  });

  it('follows the base and checks nothing when the step lists no checks', async () => {
    const where = await moved('other.txt');
    const { commands, run } = services(where, []);
    await run(tick(merging({ checks: [] })));
    expect(behind(where)).toBe('0');
    expect(commands).toHaveLength(0);
  });

  it('sends a conflict back to implement, which resolves it on the new base and lands only its change', async () => {
    const where = await moved('hello.txt', 'other.txt');
    const seen: string[] = [];
    const { specs, run } = services(
      where,
      [
        [start('i1'), wrote('hello.txt', 'hello upstream\n'), reply(push)],
        judged,
        [start('r2'), reply({ kind: 'comment', body: 'Fine.' })],
      ],
      undefined,
      spec => existsSync(join(spec.dir, 'hello.txt')) && seen.push(readFileSync(join(spec.dir, 'hello.txt'), 'utf8'))
    );
    await run(tick(graph));
    expect(specs[0]!.prompt).toMatch(
      /^the merge step sent this back: agentgraph\/7 no longer rebases onto main at \w+: conflicts in hello.txt/
    );
    expect(seen[0]).toMatch(/^<<<<<<< [^\n]*\nupstream\n=======\nhello\n>>>>>>> /);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7~1')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello upstream');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    const diff = readFileSync(issuePath(where.tracker, 8, 'diff.patch'), 'utf8');
    expect(diff).toContain('+hello upstream');
    expect(diff).not.toContain('other.txt');
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(stored!.onto).toBeUndefined();
    expect(said(where)).not.toContain('by hand');
  });

  it.each([
    ['done', { status: 'done' as const }],
    ['waiting on a question at review', { step: 'review', status: 'waiting' as const, reason: 'Which tone?' }],
  ])('follows the base for a run %s while its pull request is open, and leaves it as it was', async (_, at) => {
    const where = await moved('other.txt');
    const { specs, run } = services(where, []);
    await run(Effect.flatMap(Store, s => Effect.flatMap(s.get('run-7'), r => s.put({ ...r!, ...at }))));
    await run(tick(graph));
    expect(behind(where)).toBe('0');
    expect(specs).toHaveLength(0);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject(at);
  });

  it('sends a conflict of a done run back to implement, its setup run before the markers land', async () => {
    const where = await moved('hello.txt', 'other.txt');
    const { specs, run } = services(where, [
      [start('i1'), wrote('hello.txt', 'hello upstream\n'), reply(push)],
      judged,
      [start('r2'), reply({ kind: 'comment', body: 'Fine.' })],
    ]);
    await run(Effect.flatMap(Store, s => Effect.flatMap(s.get('run-7'), r => s.put({ ...r!, status: 'done' }))));
    await run(tick({ ...graph, setup: '! grep -q "<<<<<<<" hello.txt' }));
    expect(specs[0]!.prompt).toMatch(/^the merge step sent this back: agentgraph\/7 no longer rebases onto main/);
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello upstream');
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
  });

  it('starts the conflict workflow on a conflict, which resolves it while the run stays at merge', async () => {
    const where = await moved('hello.txt', 'other.txt');
    const conflict: typeof w = {
      ...w,
      name: 'conflict',
      on: { conflict: {} },
      steps: [{ name: 'resolve', does: { agent: 'implementor' }, checks: [], tries: 1 }],
      checks: [],
    };
    const resolving = { ...graph, workflows: { ...graph.workflows, conflict } };
    const { specs, run } = services(where, [[start('c1'), wrote('hello.txt', 'hello upstream\n'), reply(push)]]);
    await run(tick(resolving));
    await run(tick(resolving));
    expect(specs.map(s => /no longer rebases onto main at \w+: conflicts in hello.txt/.test(s.prompt))).toEqual([true]);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7~1')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello upstream');
    const runs = await run(Effect.flatMap(Store, s => s.list()));
    expect(runs.map(r => [r.workflow, r.step, r.status, r.by]).toSorted()).toEqual([
      ['conflict', 'resolve', 'done', 'run-7'],
      ['issue', 'merge', 'waiting', undefined],
    ]);
    expect(said(where)).not.toContain('by hand');
  });

  it('fails a try that leaves conflict markers and pushes nothing', async () => {
    const where = await moved('hello.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, [
      [start('i1'), reply(push)],
      judged,
      [start('i1'), reply({ kind: 'ask', question: 'Which side?' })],
    ]);
    await run(tick(graph));
    expect(specs[2]!.prompt).toContain('conflict markers left in hello.txt');
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which side?' });
    expect(stored!.onto).toBeDefined();
  });

  it('says a conflict on the issue once when the harness already had its try at that base head', async () => {
    const where = await moved('hello.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { run } = services(where, [[start('i1'), reply({ kind: 'ask', question: 'Stuck.' })]]);
    await run(tick(graph));
    const [asked] = await run(Effect.flatMap(Store, s => s.list()));
    const { onto: _onto, ...back } = asked!;
    await run(Effect.flatMap(Store, s => s.put({ ...back, step: 'merge', status: 'waiting' })));
    await run(tick(graph));
    await run(tick(graph));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(rebases(where)).toEqual([false, false]);
    expect(
      said(where).split('agentgraph/7 no longer rebases onto main: conflicts in hello.txt. Update it by hand.')
    ).toHaveLength(2);
  });

  it('asks about a conflict on the pull request after answering a review thread', async () => {
    const where = await parked();
    const at = new Date().toISOString();
    const line = { id: 'r1', author: 'morgan', body: '/agent why hello?', at, path: 'hello.txt', line: 1 };
    say(where, { ...comment(8, 'morgan', true, '/agent why hello?', at), comment: line });
    const { run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Asked for.' })]]);
    await run(tick(graph));
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    writeFileSync(join(mover, 'hello.txt'), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-q', '-m', 'upstream');
    git(mover, 'push', '-q', 'origin', 'main');
    const steps = w.steps.map(s => {
      const { back: _back, ...kept } = s;
      return s.name === 'merge' ? kept : s;
    });
    await run(tick({ ...graph, workflows: { issue: { ...w, steps } } }));
    const pr = (await run(Effect.flatMap(Tracker, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body.split(':')[0], c.under])).toEqual([
      ['Looks right.', undefined],
      ['Asked for.', 'r1'],
      ['@morgan agentgraph/7 no longer rebases onto main', undefined],
    ]);
    const issue = await run(Effect.flatMap(Tracker, f => f.issue(7)));
    expect(issue.events.filter(m => m.comment?.body.includes('Update it by hand.'))).toEqual([]);
  });

  it('keeps what a failing judged check after a rebase cost when it sends the run back', async () => {
    const where = await moved('other.txt');
    const { run } = services(where, [
      [start('j'), { type: 'usage', input: 1, output: 1, usd: 0.25 }, result({ pass: false, why: 'a claim' })],
      [start('i2'), reply({ kind: 'ask', question: 'Which claim?' })],
    ]);
    const strict = {
      ...graph,
      checks: { ...graph.checks, claims: { ...graph.checks.claims!, mode: 'block' as const } },
    };
    await run(tick(merging({ checks: ['types', 'claims'] }, strict)));
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which claim?' });
    const judging = readChecks(where.data, stored!.id).filter(e => e.check.check === 'claims');
    expect(judging.at(-1)!.usd).toBeCloseTo(0.25);
  });

  it('does nothing when the branch is up to date', async () => {
    const where = await moved('other.txt');
    git(where.origin, 'update-ref', 'refs/heads/main', git(where.origin, 'rev-parse', 'main~1'));
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(graph));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(specs).toHaveLength(0);
    expect(rebases(where)).toEqual([]);
  });

  it('checks a waiting run again under a new graph and keeps it waiting when the checks pass', async () => {
    const where = await parked();
    const { specs, run } = services(where, [judged]);
    await run(tick({ ...graph, sha: 'next' }));
    expect(specs).toHaveLength(1);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting', graph: 'next' });
    expect(rebases(where)).toEqual([]);
  });

  it('sends a waiting run back to implement when a check of the new graph fails', async () => {
    const where = await parked();
    const stricter = {
      ...graph,
      sha: 'stricter',
      checks: { ...graph.checks, types: { ...graph.checks.types!, run: '! test -e hello.txt' } },
    };
    const { specs, run } = services(where, [
      judged,
      [start('i2'), reply({ kind: 'ask', question: 'Drop hello.txt?' })],
    ]);
    await run(tick(stricter));
    expect(specs[1]!.prompt).toMatch(/^the merge step sent this back: types: /);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({
      step: 'implement',
      status: 'waiting',
      reason: 'Drop hello.txt?',
      graph: 'stricter',
    });
  });
});

describe('runStepChecks', () => {
  it('lets a check read the pending proposals from AGENTGRAPH_PROPOSALS', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestGraph('graph', { types: { run: 'cat "$AGENTGRAPH_PROPOSALS"; exit 1' } });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
      run: 'run-7',
      issue: 7,
      context: '',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: where.origin, GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [push, pull],
    };
    const { outcome } = await run(runStepChecks(step, left, small));
    const findings = outcome.kind === 'failed' ? outcome.checks[0]!.findings : undefined;
    expect(JSON.parse(findings!)).toEqual([push, pull]);
  });

  it('passes a check whose each command finds no items as empty, saying it judged nothing', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestGraph('graph', { types: { each: 'true', run: 'exit 1' } });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
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
    const { outcome } = await run(runStepChecks(step, left, small));
    expect(outcome).toEqual({ kind: 'pass' });
    const checks = readChecks(where.data, 'run-7').flatMap(t => (t.check.check === 'types' ? [t.check] : []));
    expect(checks).toEqual([
      {
        check: 'types',
        pass: true,
        empty: true,
        findings: 'Judged nothing: each found no items.',
        ms: expect.any(Number),
      },
    ]);
  });

  it('lists every failing item in full when their findings together are long', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestGraph('graph', {
      types: { each: 'seq -f %0200g 12', run: 'echo "bad $AGENTGRAPH_ITEM"; exit 1' },
    });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
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
    const { outcome } = await run(runStepChecks(step, left, small));
    const findings = outcome.kind === 'failed' ? outcome.checks[0]!.findings : undefined;
    const items = Array.from({ length: 12 }, (_, i) => `${i + 1}`.padStart(200, '0'));
    expect(findings).toBe(items.map(i => `${i}\nbad ${i}`).join('\n'));
  });

  it('fails a check without max as one finding past 20 items, opening no session', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestGraph('kit', { claims: { each: 'seq -f %0200g 21', agent: 'claim-checker' } });
    const kit = { ...small, checks: { ...small.checks, claims: { ...small.checks.claims!, mode: 'block' as const } } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const { specs, run } = services(where, []);
    const left = {
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
    const { outcome } = await run(runStepChecks(step, left, kit));
    expect(outcome).toMatchObject({
      kind: 'failed',
      checks: [
        {
          check: 'claims',
          findings: [
            '21 items, more than 20:',
            ...Array.from({ length: 21 }, (_, i) => `${i + 1}`.padStart(200, '0')),
          ].join('\n'),
        },
      ],
    });
    expect(specs).toHaveLength(0);
  });

  it('fails a check as one error carrying stderr when its each command exits nonzero', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestGraph('graph', {
      types: { each: 'echo at x.js:1 >&2; echo boom >&2; exit 1', run: 'exit 0' },
    });
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
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
    const { outcome } = await run(runStepChecks(step, left, small));
    expect(outcome.kind).toBe('failed');
    const checks = readChecks(where.data, 'run-7').flatMap(t => (t.check.check === 'types' ? [t.check] : []));
    expect(checks).toEqual([
      { check: 'types', pass: false, empty: true, findings: 'each failed: at x.js:1\nboom', ms: expect.any(Number) },
    ]);
  });

  it('lets a check read the graph directory through AGENTGRAPH_DIR', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const graphDir = join(where.root, 'graphdir');
    mkdirSync(join(graphDir, 'scripts'), { recursive: true });
    writeFileSync(join(graphDir, 'scripts', 'x.sh'), 'echo from graph\n');
    const small = {
      ...makeTestGraph('graph', { types: { run: 'sh "$AGENTGRAPH_DIR/scripts/x.sh"; exit 1' } }),
      dir: graphDir,
    };
    const step = small.workflows.issue!.steps.find(s => s.checks.includes('types'))!;
    const { run } = services(where, []);
    const left = {
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
    const { outcome } = await run(runStepChecks(step, left, small));
    const findings = outcome.kind === 'failed' ? outcome.checks[0]!.findings : undefined;
    expect(findings?.trim()).toBe('from graph');
  });

  it('lets two agents on different harnesses and models review one try side by side', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = makeTestGraph('graph');
    const agent = (
      name: string,
      harness: Graph['agents'][string]['harness'],
      model: string
    ): Graph['agents'][string] => ({
      name,
      path: `${name}.md`,
      body: `You are ${name}.`,
      harness,
      model,
      tools: [],
      returns: [],
    });
    const check = (name: string, judge: string) => ({
      name,
      path: `${name}.md`,
      body: name,
      mode: 'block' as const,
      version: 'v1',
      agent: judge,
    });
    const small = {
      ...base,
      agents: {
        ...base.agents,
        critic: agent('critic', 'claude', 'opus'),
        tester: agent('tester', 'opencode', 'smart'),
      },
      checks: { correct: check('correct', 'critic'), covered: check('covered', 'tester') },
    };
    const step = { name: 'implement', does: { agent: 'critic' }, checks: ['correct', 'covered'], tries: 3 };
    const specs: SessionSpec[] = [];
    const results = { critic: result({ pass: false, why: 'off by one' }), tester: result({ pass: true, why: 'fine' }) };
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => {
        specs.push(spec);
        return Stream.fromIterable<SessionEvent>([
          start(spec.agent),
          results[spec.agent as keyof typeof results],
          stop,
        ]);
      },
    });
    const layer = Layer.mergeAll(fileStore(where.data), hostSandbox(where.origin), judges);
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
    const { outcome } = await Effect.runPromise(runStepChecks(step, left, small).pipe(Effect.provide(layer)));
    expect(specs.map(s => [s.agent, s.harness, s.model]).toSorted()).toEqual([
      ['critic', 'claude', 'opus'],
      ['tester', 'opencode', 'smart'],
    ]);
    expect(outcome).toMatchObject({ kind: 'failed', checks: [{ check: 'correct', findings: 'off by one' }] });
  });
  it('shows every check what a human answered during the run, judges in their prompt and scripts in AGENTGRAPH_CONTEXT', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const seen = join(where.root, 'seen.md');
    const small = makeTestGraph('kit', {
      types: { run: `cp "$AGENTGRAPH_CONTEXT" ${seen}` },
      claims: { agent: 'claim-checker' },
    });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const specs: SessionSpec[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        specs.push(spec),
        Stream.fromIterable<SessionEvent>([start('j'), result({ pass: true, why: 'fine' }), stop])
      ),
    });
    const left = {
      run: 'run-7',
      issue: 7,
      context: '## #7 Add a greeting',
      reply: '',
      dir,
      base: 'HEAD',
      git: { GIT_DIR: join(dir, '.git'), GIT_WORK_TREE: dir },
      news: join(where.root, 'news', 'news.md'),
      proposals: [],
      answers: [{ asked: 'Keep the old regex?', said: 'yes, the old regex stays' }],
    };
    const layer = Layer.mergeAll(fileStore(where.data), hostSandbox(where.origin), judges);
    await Effect.runPromise(runStepChecks(step, left, small).pipe(Effect.provide(layer)));
    const context = readFileSync(seen, 'utf8');
    expect(context).toContain('## #7 Add a greeting');
    expect(context).toContain('Asked: Keep the old regex?\n\nAnswered: yes, the old regex stays');
    expect(specs[0]!.prompt).toContain('Answered: yes, the old regex stays');
  });

  it('judges a try whose script check failed, so the findings of both come back together', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const kit = makeTestGraph('kit', {
      types: { run: 'echo x.ts:1 error; exit 1' },
      claims: { agent: 'claim-checker' },
    });
    const small = { ...kit, checks: { ...kit.checks, claims: { ...kit.checks.claims!, mode: 'block' as const } } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const judges = Layer.succeed(Session, {
      open: () => Stream.fromIterable<SessionEvent>([start('j'), result({ pass: false, why: 'a claim' }), stop]),
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
    const { outcome } = await Effect.runPromise(runStepChecks(step, left, small).pipe(Effect.provide(layer)));
    expect(outcome).toMatchObject({
      kind: 'failed',
      checks: [
        { check: 'types', findings: 'x.ts:1 error' },
        { check: 'claims', findings: 'a claim' },
      ],
    });
  });

  it('judges again only what changed: a pass on the same diff is kept, a fail or a new diff is judged', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const small = makeTestGraph('kit', { claims: { each: 'echo a; echo b', agent: 'claim-checker' } });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const judgedItems: string[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => {
        const item = spec.prompt.includes('\n\nb\n\n') ? 'b' : 'a';
        judgedItems.push(item);
        const judged = item === 'a' ? result({ pass: true, why: 'fine' }) : result({ pass: false, why: 'b is off' });
        return Stream.fromIterable<SessionEvent>([start('j'), judged, stop]);
      },
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
    const once = () => Effect.runPromise(runStepChecks(step, left, small).pipe(Effect.provide(layer)));
    await once();
    await once();
    expect(judgedItems.sort()).toEqual(['a', 'b', 'b']);
    writeFileSync(join(dir, 'hello.txt'), 'hello\n');
    judgedItems.length = 0;
    await once();
    expect(judgedItems.sort()).toEqual(['a', 'b']);
    const copy = join(where.root, 'copy');
    git(where.root, 'clone', '-q', dir, copy);
    writeFileSync(join(copy, 'hello.txt'), 'hello\n');
    const moved = { ...left, dir: copy, git: { GIT_DIR: join(copy, '.git'), GIT_WORK_TREE: copy } };
    judgedItems.length = 0;
    await Effect.runPromise(runStepChecks(step, moved, small).pipe(Effect.provide(layer)));
    expect(judgedItems).toEqual(['b']);
    judgedItems.length = 0;
    const answered = { ...moved, answers: [{ asked: 'Is a fine?', said: 'Not any more.' }] };
    await Effect.runPromise(runStepChecks(step, answered, small).pipe(Effect.provide(layer)));
    expect(judgedItems.sort()).toEqual(['a', 'b']);
  });

  it('judges a kept pass again when the judge system prompt, harness or tools change', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const small = makeTestGraph('kit', { claims: { agent: 'claim-checker' } });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const specs: SessionSpec[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        specs.push(spec),
        Stream.fromIterable<SessionEvent>([start('j'), result({ pass: true, why: 'fine' }), stop])
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
    const judge = small.agents['claim-checker']!;
    const as = (agent: Partial<typeof judge>) => ({
      ...small,
      agents: { ...small.agents, 'claim-checker': { ...judge, ...agent } },
    });
    const once = (h: Graph) => Effect.runPromise(runStepChecks(step, left, h).pipe(Effect.provide(layer)));
    await once(small);
    await once(small);
    expect(specs).toHaveLength(1);
    await once(as({ body: `${judge.body}\nBe stricter.` }));
    expect(specs).toHaveLength(2);
    await once(as({ harness: judge.harness === 'pi' ? 'claude' : 'pi' }));
    expect(specs).toHaveLength(3);
    await once(as({ tools: [...judge.tools, 'WebFetch'] }));
    expect(specs).toHaveLength(4);
  });

  describe('a judge session that did not end normally', () => {
    const judged = async (
      ends: (SessionEvent | SessionEvent[])[],
      mode: 'block' | 'warn' | 'stop' = 'block',
      more: Graph['checks'] = {}
    ) => {
      const where = world();
      const dir = join(where.root, 'work');
      mkdirSync(dir);
      mkdirSync(join(where.root, 'news'));
      git(dir, 'init', '-q');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
      const base = makeTestGraph('graph');
      const critic: Graph['agents'][string] = {
        name: 'critic',
        path: 'critic.md',
        body: 'critic',
        harness: 'claude',
        tools: [],
        returns: [],
      };
      const graph = {
        ...base,
        agents: { ...base.agents, critic },
        checks: {
          correct: { name: 'correct', path: 'c.md', body: 'c', mode, agent: 'critic', version: 'v1' },
          ...more,
        },
      };
      const step = {
        name: 'implement',
        does: { agent: 'critic' },
        checks: ['correct', ...Object.keys(more)],
        tries: 3,
      };
      let opened = 0;
      const judges = Layer.succeed(Session, {
        open: (spec: SessionSpec) =>
          Stream.fromIterable<SessionEvent>([start(spec.agent), ...[ends[opened++]!].flat()]),
      });
      const layer = Layer.mergeAll(fileStore(where.data), hostSandbox(where.origin), judges);
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
      const exit = await Effect.runPromiseExit(runStepChecks(step, left, graph).pipe(Effect.provide(layer)));
      return { exit, opened, data: where.data };
    };
    const killed: Extract<SessionEvent, { type: 'end' }> = { type: 'end', final: 'Killed', ended: 'error', exit: 137 };
    const pass = [result({ pass: true, why: 'fine' }), stop];

    it('retries once and takes the second result', async () => {
      const { exit, opened } = await judged([killed, pass]);
      expect(opened).toBe(2);
      expect(Exit.isSuccess(exit) && exit.value.outcome).toEqual({ kind: 'pass' });
    });

    it('fails as an error that says it could not be judged, never as a finding', async () => {
      const { exit, opened } = await judged([killed, killed]);
      expect(opened).toBe(2);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('could not be judged');
    });

    it('records an error finding and goes on when the check only warns', async () => {
      const { exit, opened, data } = await judged([killed, killed], 'warn');
      expect(opened).toBe(2);
      expect(Exit.isSuccess(exit) && exit.value.outcome).toEqual({ kind: 'pass' });
      const found = readChecks(data, 'run-7').map(t => t.check);
      expect(found).toMatchObject([
        { check: 'correct', pass: false, findings: expect.stringContaining('could not be judged') },
      ]);
    });

    it('parks the run when a stop check cannot be judged', async () => {
      const { exit } = await judged([killed, killed], 'stop');
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain(
        'check critic could not be judged: session error (exit 137), final: Killed'
      );
    });

    it('stops on a failed stop check even when another check cannot be judged', async () => {
      const red = { name: 'red', path: 'r.md', body: '', mode: 'stop' as const, run: 'exit 1', version: 'v1' };
      const { exit } = await judged([killed, killed], 'block', { red });
      expect(Exit.isSuccess(exit) && exit.value.outcome).toMatchObject({ kind: 'stop' });
    });

    it('counts a stream that ends without its end line as an error', async () => {
      const cut: SessionEvent[] = [result({ pass: true, why: 'fine' })];
      const { exit, data } = await judged([cut, cut]);
      expect(Exit.isFailure(exit)).toBe(true);
      const sessions = readJudgeSessions(data);
      expect(sessions.map(s => s.ended)).toEqual(['error', 'error']);
    });

    it('counts a non-zero exit as an error even after a clean stop', async () => {
      const { exit, data } = await judged([[result({ pass: true, why: 'fine' }), { ...stop, exit: 1 }], pass]);
      expect(Exit.isSuccess(exit) && exit.value.outcome).toEqual({ kind: 'pass' });
      const sessions = readJudgeSessions(data);
      expect(sessions).toMatchObject([
        { ended: 'error', exit: 1 },
        { ended: 'stop', exit: 0 },
      ]);
    });

    it('treats a clean stop without a result the same way', async () => {
      const mute = { ...stop, final: 'looks fine to me' };
      const { exit, data } = await judged([mute, mute]);
      expect(Exit.isFailure(exit)).toBe(true);
      expect(JSON.stringify(exit)).toContain('check critic could not be judged: session gave no result');
      expect(readJudgeSessions(data).map(s => s.ended)).toEqual(['stop', 'stop']);
    });
  });
});
