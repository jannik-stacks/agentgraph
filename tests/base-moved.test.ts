import { existsSync, mkdirSync, readdirSync, readFileSync, symlinkSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect, Exit, Layer, Stream } from 'effect';
import { describe, expect, it } from 'vitest';
import { drive, runStepChecks, tick } from '../src/engine.ts';
import { Forge } from '../src/forge.ts';
import { type Command } from '../src/sandbox.ts';
import { Session } from '../src/session.ts';
import { fileStore, Store } from '../src/store.ts';
import type { SessionEvent, SessionSpec } from '../src/trace.ts';
import type { Hub } from '../src/hub.ts';
import { type Step } from '../src/workflow.ts';
import { hostSandbox } from './doubles/sandbox.ts';
import { makeTestHub, reply, start, wrote } from './fixtures.ts';
import { git } from './kit.ts';
import { hub, w, world, push, pull, judged, services, readTrace, fresh, say, comment } from './world.ts';

describe('a base that moved', () => {
  /** Run 7 waiting at merge on pull request #8. */
  const parked = async () => {
    const where = world();
    const first = services(where, [
      [start('t1'), reply({ kind: 'comment', body: 'Brief' })],
      [start('i1'), wrote('hello.txt', 'hello\n'), reply(push, pull)],
      judged,
      [start('r1'), reply({ kind: 'comment', body: 'Looks right.' })],
    ]);
    expect(await first.run(drive(w, fresh(), hub))).toMatchObject({ step: 'merge', status: 'waiting', hub: 'fixture' });
    return where;
  };
  /** Run 7 parked, then `main` gets one commit that writes each file. */
  const moved = async (...files: string[]) => {
    const where = await parked();
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    for (const file of files) writeFileSync(join(mover, file), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-q', '-m', 'upstream');
    git(mover, 'push', '-q', 'origin', 'main');
    return where;
  };
  const behind = (where: ReturnType<typeof world>) => git(where.origin, 'rev-list', '--count', 'agentgraph/7..main');
  const rebases = (where: ReturnType<typeof world>) =>
    readTrace(where.data, 'run-7').flatMap(t =>
      'applied' in t && t.applied.proposal.kind === 'rebase' ? [t.applied.ok] : []
    );
  /** The hub with the merge step's fields replaced. */
  const merging = (fields: Partial<Step>, base = hub) => ({
    ...base,
    workflows: { issue: { ...w, steps: w.steps.map(s => (s.name === 'merge' ? { ...s, ...fields } : s)) } },
  });
  const ran = (commands: Command[], script: string) => commands.some(c => c.args.includes(script));
  const said = (where: ReturnType<typeof world>) =>
    readdirSync(where.forge)
      .filter(f => f.endsWith('.jsonl'))
      .map(f => readFileSync(join(where.forge, f), 'utf8'))
      .join('');

  it('keeps merge-only edits when file-forge cannot rebase their history', async () => {
    const where = await parked();
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    const left = git(where.origin, 'rev-parse', 'agentgraph/7');
    writeFileSync(join(mover, 'right.txt'), 'right\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Right');
    git(mover, 'merge', '--no-ff', '--no-commit', left);
    writeFileSync(join(mover, 'resolution.txt'), 'merge-only\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Merge');
    const tip = git(mover, 'rev-parse', 'HEAD');
    git(mover, 'push', '-q', 'origin', 'HEAD:agentgraph/7');
    const pr = JSON.parse(readFileSync(join(where.forge, '8', 'pull.json'), 'utf8'));
    writeFileSync(join(where.forge, '8', 'pull.json'), JSON.stringify({ ...pr, head: tip }));
    git(mover, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(mover, 'upstream.txt'), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Upstream');
    git(mover, 'push', '-q', 'origin', 'HEAD:main');
    const { run } = services(where, []);
    await run(tick(hub, 7));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(tip);
    expect(git(where.origin, 'show', 'agentgraph/7:resolution.txt')).toBe('merge-only');
    expect(rebases(where)).toContain(false);
  });

  it.each(['workflow', 'symlink', 'oversize'])('refuses unsafe content during a file-forge rebase: %s', async kind => {
    const where = await parked();
    const mover = join(where.root, 'mover');
    git(where.root, 'clone', '-q', where.origin, mover);
    git(mover, 'checkout', '-q', '-B', 'agentgraph/7', 'origin/agentgraph/7');
    if (kind === 'workflow') {
      mkdirSync(join(mover, '.github', 'workflows'), { recursive: true });
      writeFileSync(join(mover, '.github', 'workflows', 'x.yml'), 'run: bad\n');
    } else if (kind === 'symlink') symlinkSync('README.md', join(mover, 'link.txt'));
    else writeFileSync(join(mover, 'big.txt'), 'x'.repeat((1 << 20) + 1));
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Unsupported content');
    const tip = git(mover, 'rev-parse', 'HEAD');
    git(mover, 'push', '-q', 'origin', 'agentgraph/7');
    const pr = JSON.parse(readFileSync(join(where.forge, '8', 'pull.json'), 'utf8'));
    writeFileSync(join(where.forge, '8', 'pull.json'), JSON.stringify({ ...pr, head: tip }));
    git(mover, 'reset', '-q', '--hard', 'origin/main');
    writeFileSync(join(mover, 'upstream.txt'), 'upstream\n');
    git(mover, 'add', '-A');
    git(mover, 'commit', '-qm', 'Upstream');
    git(mover, 'push', '-q', 'origin', 'HEAD:main');
    const { run } = services(where, []);
    await run(tick(hub, 7));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(tip);
    expect(rebases(where)).toContain(false);
  });

  it('rebases a clean branch with no model and runs only its script checks when the change stays the same', async () => {
    const where = await moved('other.txt');
    expect(behind(where)).toBe('1');
    const { specs, commands, run } = services(where, []);
    await run(tick(hub));
    expect(behind(where)).toBe('0');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello');
    expect(specs).toHaveLength(0);
    expect(ran(commands, '! grep -q TODO hello.txt')).toBe(true);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(rebases(where)).toEqual([true]);
  });

  it('merges the base into the branch with a plain push by default', async () => {
    const where = await moved('other.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(merging({ follow: 'merge' })));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7^1')).toBe(before);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7^2')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(specs).toHaveLength(0);
    const diff = readFileSync(join(where.forge, '8', 'diff.patch'), 'utf8');
    expect(diff).toContain('hello.txt');
    expect(diff).not.toContain('other.txt');
  });

  it('leaves the branch behind its base when the step follows it not at all', async () => {
    const where = await moved('other.txt');
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(merging({ follow: 'none' })));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(behind(where)).toBe('1');
    expect(specs).toHaveLength(0);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
  });

  it('judges after the script checks pass when the step names a judged check, and only then', async () => {
    const where = await moved('other.txt');
    const { specs, run } = services(where, [judged]);
    await run(tick(merging({ checks: ['types', 'claims'] })));
    expect(specs).toHaveLength(1);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });

    const red = await moved('other.txt');
    const failing = services(red, [[start('i2'), reply({ kind: 'ask', question: 'Why red?' })]]);
    const strict = { ...hub, checks: { ...hub.checks, types: { ...hub.checks.types!, run: 'exit 1' } } };
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
      ...hub,
      ...(setup && { setup }),
      checks: { ...hub.checks, types: { ...hub.checks.types!, run: script } },
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
    await run(tick(hub));
    expect(specs[0]!.prompt).toMatch(
      /^the merge step sent this back: agentgraph\/7 no longer rebases onto main at \w+: conflicts in hello.txt/
    );
    expect(seen[0]).toMatch(/^<<<<<<< [^\n]*\nupstream\n=======\nhello\n>>>>>>> /);
    expect(git(where.origin, 'rev-parse', 'agentgraph/7~1')).toBe(git(where.origin, 'rev-parse', 'main'));
    expect(git(where.origin, 'show', 'agentgraph/7:hello.txt')).toBe('hello upstream');
    expect(git(where.origin, 'show', 'agentgraph/7:other.txt')).toBe('upstream');
    const diff = readFileSync(join(where.forge, '8', 'diff.patch'), 'utf8');
    expect(diff).toContain('+hello upstream');
    expect(diff).not.toContain('other.txt');
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting' });
    expect(stored!.onto).toBeUndefined();
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
    await run(tick(hub));
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
    await run(tick(hub));
    const [asked] = await run(Effect.flatMap(Store, s => s.list()));
    const { onto: _onto, ...back } = asked!;
    await run(Effect.flatMap(Store, s => s.put({ ...back, step: 'merge', status: 'waiting' })));
    await run(tick(hub));
    await run(tick(hub));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(rebases(where)).toEqual([false, false]);
    expect(
      said(where).split('agentgraph/7 no longer rebases onto main: conflicts in hello.txt. Update it by hand.')
    ).toHaveLength(2);
  });

  it('says a conflict at the top of the pull request, not under a thread the run already answered', async () => {
    const where = await parked();
    const at = new Date().toISOString();
    const line = { id: 'r1', author: 'morgan', body: '/agent why hello?', at, path: 'hello.txt', line: 1 };
    say(where, { ...comment(8, 'morgan', true, '/agent why hello?', at), comment: line });
    const { run } = services(where, [[start('f'), reply({ kind: 'comment', body: 'Asked for.' })]]);
    await run(tick(hub));
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
    await run(tick({ ...hub, workflows: { issue: { ...w, steps } } }));
    const pr = (await run(Effect.flatMap(Forge, f => f.issue(8)))).events.flatMap(m => m.comment ?? []);
    expect(pr.filter(c => c.author === 'agentgraph[bot]').map(c => [c.body.split(':')[0], c.under])).toEqual([
      ['Looks right.', undefined],
      ['Asked for.', 'r1'],
      ['agentgraph/7 no longer rebases onto main', undefined],
    ]);
  });

  it('keeps what a failing judged check after a rebase cost when it sends the run back', async () => {
    const where = await moved('other.txt');
    const { run } = services(where, [
      [start('j'), { type: 'usage', input: 1, output: 1, usd: 0.25 }, { type: 'text', text: 'FAIL a claim' }],
      [start('i2'), reply({ kind: 'ask', question: 'Which claim?' })],
    ]);
    const [was] = await run(Effect.flatMap(Store, s => s.list()));
    const strict = { ...hub, checks: { ...hub.checks, claims: { ...hub.checks.claims!, mode: 'block' as const } } };
    await run(tick(merging({ checks: ['types', 'claims'] }, strict)));
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Which claim?' });
    expect(stored!.usd).toBeCloseTo(was!.usd + 0.25);
  });

  it('does nothing when the branch is up to date', async () => {
    const where = await moved('other.txt');
    git(where.origin, 'update-ref', 'refs/heads/main', git(where.origin, 'rev-parse', 'main~1'));
    const before = git(where.origin, 'rev-parse', 'agentgraph/7');
    const { specs, run } = services(where, []);
    await run(tick(hub));
    expect(git(where.origin, 'rev-parse', 'agentgraph/7')).toBe(before);
    expect(specs).toHaveLength(0);
    expect(rebases(where)).toEqual([]);
  });

  it('checks a waiting run again under a new hub and keeps it waiting when the checks pass', async () => {
    const where = await parked();
    const { specs, run } = services(where, [judged]);
    await run(tick({ ...hub, sha: 'next' }));
    expect(specs).toHaveLength(1);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'merge', status: 'waiting', hub: 'next' });
    expect(rebases(where)).toEqual([]);
  });

  it('sends a waiting run back to implement when a check of the new hub fails', async () => {
    const where = await parked();
    const stricter = {
      ...hub,
      sha: 'stricter',
      checks: { ...hub.checks, types: { ...hub.checks.types!, run: '! test -e hello.txt' } },
    };
    const { specs, run } = services(where, [
      judged,
      [start('i2'), reply({ kind: 'ask', question: 'Drop hello.txt?' })],
    ]);
    await run(tick(stricter));
    expect(specs[1]!.prompt).toMatch(/^the merge step sent this back: types: /);
    const [stored] = await run(Effect.flatMap(Store, s => s.list()));
    expect(stored).toMatchObject({ step: 'implement', status: 'waiting', reason: 'Drop hello.txt?', hub: 'stricter' });
  });
});

describe('runStepChecks', () => {
  it('lets a check read the pending proposals from AGENTGRAPH_PROPOSALS', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestHub('hub', { types: { run: 'cat "$AGENTGRAPH_PROPOSALS"; exit 1' } });
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
    const small = makeTestHub('hub', { types: { each: 'true', run: 'exit 1' } });
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
    const checks = readTrace(where.data, 'run-7').flatMap(t =>
      'check' in t && t.check.check === 'types' ? [t.check] : []
    );
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

  it('fails a check without max as one finding past 20 items, opening no session', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestHub('kit', { claims: { each: 'seq 21', agent: 'claim-checker' } });
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
      checks: [{ check: 'claims', findings: '21 items, more than 20' }],
    });
    expect(specs).toHaveLength(0);
  });

  it('fails a check as one error carrying stderr when its each command exits nonzero', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const small = makeTestHub('hub', { types: { each: 'echo at x.js:1 >&2; echo boom >&2; exit 1', run: 'exit 0' } });
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
    const checks = readTrace(where.data, 'run-7').flatMap(t =>
      'check' in t && t.check.check === 'types' ? [t.check] : []
    );
    expect(checks).toEqual([
      { check: 'types', pass: false, findings: 'each failed: at x.js:1\nboom', ms: expect.any(Number) },
    ]);
  });

  it('lets a check read the hub directory through AGENTGRAPH_HUB', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    const hubDir = join(where.root, 'hubdir');
    mkdirSync(join(hubDir, 'scripts'), { recursive: true });
    writeFileSync(join(hubDir, 'scripts', 'x.sh'), 'echo from hub\n');
    const small = {
      ...makeTestHub('hub', { types: { run: 'sh "$AGENTGRAPH_HUB/scripts/x.sh"; exit 1' } }),
      dir: hubDir,
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
    expect(findings?.trim()).toBe('from hub');
  });

  it('lets two agents on different harnesses and models review one try side by side', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const base = makeTestHub('hub');
    const agent = (name: string, harness: Hub['agents'][string]['harness'], model: string): Hub['agents'][string] => ({
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
    const verdicts: Record<string, string> = { critic: 'FAIL off by one', tester: 'PASS' };
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => {
        specs.push(spec);
        return Stream.fromIterable<SessionEvent>([
          start(spec.agent),
          { type: 'end', final: verdicts[spec.agent]!, ended: 'stop', exit: 0 },
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
    expect(specs.map(s => [s.agent, s.harness, s.model]).sort()).toEqual([
      ['critic', 'claude', 'opus'],
      ['tester', 'opencode', 'smart'],
    ]);
    expect(outcome).toMatchObject({ kind: 'failed', checks: [{ check: 'correct', findings: 'FAIL off by one' }] });
  });
  it('shows every check what a human answered during the run, judges in their prompt and scripts in AGENTGRAPH_CONTEXT', async () => {
    const where = world();
    const dir = join(where.root, 'work');
    mkdirSync(dir);
    mkdirSync(join(where.root, 'news'));
    git(dir, 'init', '-q');
    git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
    const seen = join(where.root, 'seen.md');
    const small = makeTestHub('kit', {
      types: { run: `cp "$AGENTGRAPH_CONTEXT" ${seen}` },
      claims: { agent: 'claim-checker' },
    });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const specs: SessionSpec[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        specs.push(spec),
        Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final: 'PASS', ended: 'stop', exit: 0 }])
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
    const kit = makeTestHub('kit', {
      types: { run: 'echo x.ts:1 error; exit 1' },
      claims: { agent: 'claim-checker' },
    });
    const small = { ...kit, checks: { ...kit.checks, claims: { ...kit.checks.claims!, mode: 'block' as const } } };
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['types', 'claims'], tries: 3 };
    const judges = Layer.succeed(Session, {
      open: () =>
        Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final: 'FAIL a claim', ended: 'stop', exit: 0 }]),
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
        { check: 'claims', findings: 'FAIL a claim' },
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
    const small = makeTestHub('kit', { claims: { each: 'echo a; echo b', agent: 'claim-checker' } });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const judgedItems: string[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => {
        const item = spec.prompt.includes('\n\nb\n\n') ? 'b' : 'a';
        judgedItems.push(item);
        const final = item === 'a' ? 'PASS' : 'FAIL b is off';
        return Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final, ended: 'stop', exit: 0 }]);
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
    const small = makeTestHub('kit', { claims: { agent: 'claim-checker' } });
    const step = { name: 'implement', does: { agent: 'claim-checker' }, checks: ['claims'], tries: 3 };
    const specs: SessionSpec[] = [];
    const judges = Layer.succeed(Session, {
      open: (spec: SessionSpec) => (
        specs.push(spec),
        Stream.fromIterable<SessionEvent>([start('j'), { type: 'end', final: 'PASS', ended: 'stop', exit: 0 }])
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
    const once = (h: Hub) => Effect.runPromise(runStepChecks(step, left, h).pipe(Effect.provide(layer)));
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
      more: Hub['checks'] = {}
    ) => {
      const where = world();
      const dir = join(where.root, 'work');
      mkdirSync(dir);
      mkdirSync(join(where.root, 'news'));
      git(dir, 'init', '-q');
      git(dir, 'commit', '-q', '--allow-empty', '-m', 'base');
      const base = makeTestHub('hub');
      const critic: Hub['agents'][string] = {
        name: 'critic',
        path: 'critic.md',
        body: 'critic',
        harness: 'claude',
        tools: [],
        returns: [],
      };
      const hub = {
        ...base,
        agents: { ...base.agents, critic },
        checks: { correct: { name: 'correct', path: 'c.md', body: 'c', mode, agent: 'critic' }, ...more },
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
      const exit = await Effect.runPromiseExit(runStepChecks(step, left, hub).pipe(Effect.provide(layer)));
      return { exit, opened, data: where.data };
    };
    const killed: Extract<SessionEvent, { type: 'end' }> = { type: 'end', final: 'Killed', ended: 'error', exit: 137 };
    const pass: Extract<SessionEvent, { type: 'end' }> = { type: 'end', final: 'PASS fine', ended: 'stop', exit: 0 };

    it('retries once and takes the second verdict', async () => {
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
      const found = readTrace(data, 'run-7').flatMap(t => ('check' in t ? [t.check] : []));
      expect(found).toMatchObject([
        { check: 'correct', pass: false, findings: expect.stringContaining('could not be judged') },
      ]);
    });

    it('parks the run when a stop check cannot be judged', async () => {
      const { exit } = await judged([killed, killed], 'stop');
      expect(Exit.isFailure(exit)).toBe(true);
    });

    it('stops on a failed stop check even when another check cannot be judged', async () => {
      const red = { name: 'red', path: 'r.md', body: '', mode: 'stop' as const, run: 'exit 1' };
      const { exit } = await judged([killed, killed], 'block', { red });
      expect(Exit.isSuccess(exit) && exit.value.outcome).toMatchObject({ kind: 'stop' });
    });

    it('counts a stream that ends without its end line as an error', async () => {
      const cut: SessionEvent[] = [{ type: 'text', text: 'PASS fine' }];
      const { exit, data } = await judged([cut, cut]);
      expect(Exit.isFailure(exit)).toBe(true);
      const sessions = readTrace(data, 'run-7').flatMap(t => ('session' in t ? [t.session] : []));
      expect(sessions.map(s => s.ended)).toEqual(['error', 'error']);
    });

    it('counts a non-zero exit as an error even after a clean stop', async () => {
      const { exit, data } = await judged([{ ...pass, exit: 1 }, pass]);
      expect(Exit.isSuccess(exit) && exit.value.outcome).toEqual({ kind: 'pass' });
      const sessions = readTrace(data, 'run-7').flatMap(t => ('session' in t ? [t.session] : []));
      expect(sessions).toMatchObject([
        { ended: 'error', exit: 1 },
        { ended: 'stop', exit: 0 },
      ]);
    });

    it('treats a clean stop without a verdict line the same way', async () => {
      const mute = { ...pass, final: 'looks fine to me' };
      const { exit } = await judged([mute, mute]);
      expect(Exit.isFailure(exit)).toBe(true);
    });
  });
});
