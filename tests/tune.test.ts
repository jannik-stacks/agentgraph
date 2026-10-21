import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { decide, init, paired, propose, run, step, tuneRows, type tunesOf } from '../bin/tune.ts';
import { fixtures } from '../studio/fixtures.ts';
import { tmp } from './fixtures.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.BOTHUB_TUNE;
  delete process.env.VITE_BHM_TUNE;
});

const evalOf = (delta: number, pUp = 0): Parameters<typeof decide>[1] => ({
  candidate: 'c',
  split: 'fit',
  cases: [],
  quality: 0,
  ci: [0, 0],
  delta,
  pUp,
  usd: 0,
  minutes: 0,
  codex: 0,
  claude5h: 0,
});

describe('paired and decide', () => {
  it('measures the gain of b over a case by case', () => {
    expect(paired([0, 0, 0, 0], [1, 1, 1, 1])).toEqual({ delta: 1, pUp: 1, ci: [1, 1] });
    expect(paired([1, 0, 1, 0], [1, 0, 1, 0])).toEqual({ delta: 0, pUp: 0, ci: [0, 0] });
    const mixed = paired([0, 0, 0, 0, 0], [1, 1, 1, 0, -1]);
    expect(mixed.delta).toBe(0.4);
    expect(mixed.pUp).toBeGreaterThan(0.8);
    expect(mixed.ci[0]).toBeLessThan(0.4);
    expect(paired([], [])).toEqual({ delta: 0, pUp: 0, ci: [0, 0] });
  });

  it('screens out clear losers and keeps only a confident gain', () => {
    const t = { keep: { p: 0.8, delta: 0.03, screen: 0.2 } };
    expect(decide(t, evalOf(-0.25))).toBe('screened-out');
    expect(decide(t, evalOf(-0.1))).toBe('discarded');
    expect(decide(t, evalOf(0), evalOf(0.05, 0.9))).toBe('kept');
    expect(decide(t, evalOf(0), evalOf(0.05, 0.7))).toBe('discarded');
    expect(decide(t, evalOf(0), evalOf(0.02, 0.95))).toBe('discarded');
  });
});

/** A bench stand-in: a case passes when the candidate hub has `skills/<case>.md` or `skills/all.md`. */
const fakeBench = (ran: { id: string; case: string }[]) => ({
  run: async (_dir: string, _t: unknown, jobs: { id: string; case: string }[]) => void ran.push(...jobs),
  rows: (dir: string, id: string) =>
    ran
      .filter(j => j.id === id)
      .map(j => ({
        point: 'opencode:luna/v2@e/h/s',
        case: j.case,
        repeat: 1,
        strata: {},
        hidden: +['all', j.case].some(n => existsSync(join(dir, 'cands', id, 'hub/skills', `${n}.md`))) as 0 | 1,
        vsHuman: {},
        findings: { critical: 0, high: 0 },
        answers: 0,
        minutes: 2,
        tokens: {},
        usd: 0.1,
      })),
  codex: () => 10,
  propose: async (o: { tune: string; proposer: string; id: string; from: string }) => {
    const hub = join(o.tune, 'cands', o.id, 'hub');
    mkdirSync(join(o.tune, 'cands', o.id));
    spawnSync('cp', ['-R', o.from, hub]);
    mkdirSync(join(hub, 'skills'), { recursive: true });
    writeFileSync(join(hub, 'skills', o.proposer === 'retro' ? 'all.md' : 'none.md'), 'Run the tests.\n');
    return { hub, rationale: `${o.proposer} idea`, usage: { fiveHour: 10, week: 50 } };
  },
});

const setup = () => {
  const root = tmp('tune');
  dirs.push(root);
  process.env.BOTHUB_TUNE = join(root, 'tune');
  const cases = join(root, 'cases');
  const splits: Record<string, string> = {};
  const add = (id: string, split: string, day: number, bucket = 'tests') => {
    mkdirSync(join(cases, id), { recursive: true });
    const meta = {
      repo: 'me/demo',
      base: 'b',
      merged: 'm',
      mergedAt: `2026-01-${10 + day}`,
      bucket,
      tests: ['a.test.ts'],
    };
    writeFileSync(join(cases, id, 'case.json'), JSON.stringify(meta));
    writeFileSync(join(cases, id, 'issue.md'), `# ${id}\n`);
    splits[id] = split;
  };
  for (const [i, id] of ['m1', 'm2', 'm3', 'm4', 'f1', 'f2', 'f3', 'f4'].entries()) add(id, 'train', i);
  add('v1', 'validate', 10);
  add('v2', 'validate', 11);
  add('t1', 'test', 12);
  add('n1', 'train', 13, 'no-tests');
  writeFileSync(join(root, 'splits.json'), JSON.stringify(splits));
  return { cases, splits: join(root, 'splits.json'), repos: join(root, 'repos'), point: 'opencode:luna' };
};

describe('tune loop', () => {
  it('starts from the minimal hub, keeps a gain, drops a loss and resumes', async () => {
    const ran: { id: string; case: string }[] = [];
    const io = fakeBench(ran) as unknown as Parameters<typeof step>[2];
    const dir = await init('demo', setup(), io);
    const check = spawnSync(process.execPath, ['bin/run.ts', 'check', '--hub', join(dir, 'cands/i000-init/hub')], {
      encoding: 'utf8',
      env: { ...process.env, NODE_OPTIONS: '' },
    });
    expect(check.status, check.stdout + check.stderr).toBe(0);
    const { tune } = tuneRows(dir);
    expect(Object.entries(tune.cases).sort()).toEqual([
      ['f1', 'fit'],
      ['f2', 'fit'],
      ['f3', 'fit'],
      ['f4', 'fit'],
      ['m1', 'mine'],
      ['m2', 'mine'],
      ['m3', 'mine'],
      ['m4', 'mine'],
      ['t1', 'test'],
      ['v1', 'validate'],
      ['v2', 'validate'],
    ]);
    expect(ran.map(j => j.case).sort()).toEqual(['f1', 'f2', 'f3', 'f4', 'v1', 'v2']);

    const fromHub = join(tuneRoot(dir), 'draft');
    spawnSync('cp', ['-R', join(dir, 'cands/i000-init/hub'), fromHub]);
    mkdirSync(join(fromHub, 'skills'));
    writeFileSync(join(fromHub, 'skills', 'f1.md'), 'Mind f1.\n');
    expect(propose(dir, fromHub, 'f1 needs care').id).toBe('i001-manual');
    await step(dir, { k: 1, proposers: ['manual'] }, io);
    expect(tuneRows(dir).steps.map(s => [s.id, s.verdict])).toEqual([
      ['i000-init', 'kept'],
      ['i001-manual', 'discarded'],
    ]);
    expect(tuneRows(dir).steps[1]!.why).toMatch(/below the bar/);

    const made = await step(dir, { k: 3, proposers: ['retro', 'history'] }, io);
    expect(made.map(s => [s.id, s.verdict])).toEqual([
      ['i002-retro', 'kept'],
      ['i002-history', 'discarded'],
    ]);
    const retro = made.find(s => s.id === 'i002-retro')!;
    expect(retro.evals.map(e => [e.split, e.cases.length, e.delta])).toEqual([
      ['fit', 4, 1],
      ['validate', 2, 1],
    ]);
    expect(retro.diff).toContain('skills/all.md');
    expect(retro.why).toMatch(/select gain 1 over 6 cases/);
    expect(JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8')).claude.week).toEqual({ start: 50, now: 50 });

    mkdirSync(join(dir, 'manual'));
    const patch = spawnSync('git', ['--git-dir', join(dir, 'hub.git'), 'diff', retro.hub, retro.parent], {
      encoding: 'utf8',
    }).stdout;
    writeFileSync(join(dir, 'manual', 'undo.patch'), `Undo the all skill.\n\n${patch}`);
    const third = await step(dir, { k: 1, proposers: ['manual'] }, io);
    expect(third.map(s => [s.id, s.verdict])).toEqual([['i003-manual', 'screened-out']]);
    expect(third[0]!.rationale).toBe('Undo the all skill.');
    expect(existsSync(join(dir, 'manual', 'applied', 'undo.patch'))).toBe(true);

    const refs = spawnSync('git', ['--git-dir', join(dir, 'hub.git'), 'for-each-ref', '--format=%(refname)'], {
      encoding: 'utf8',
    }).stdout;
    for (const s of tuneRows(dir).steps) expect(refs).toContain(`refs/cand/${s.id}`);
    const main = spawnSync('git', ['--git-dir', join(dir, 'hub.git'), 'rev-parse', 'main'], { encoding: 'utf8' });
    expect(main.stdout.trim()).toBe(retro.hub);

    const before = ran.length;
    expect(await step(dir, { k: 1, proposers: ['manual'] }, io)).toEqual([]);
    expect(ran.length).toBe(before);

    let asked = 0;
    const silent = { ...io, propose: async () => (asked++, { rationale: 'nothing' }) } as unknown as typeof io;
    await run(dir, { iterations: 5, proposers: ['retro'] }, silent);
    expect(asked).toBe(1);
  });
});

const tuneRoot = (dir: string) => join(dir, '..', '..');

describe('/core/compound', () => {
  it('answers every tune under VITE_BHM_TUNE with its steps', async () => {
    const routes: Record<string, (req: unknown, res: unknown) => Promise<void>> = {};
    const plugin = fixtures().configureServer as (server: unknown) => void;
    plugin({ middlewares: { use: (path: string, f: (typeof routes)[string]) => (routes[path] = f) } });
    process.env.VITE_BHM_TUNE = join(import.meta.dirname, 'fixtures/tune');
    let body = '';
    await routes['/core/compound']!({}, { setHeader: () => {}, end: (b: string) => (body = b) });
    const tunes = JSON.parse(body) as ReturnType<typeof tunesOf>;
    expect(tunes.map(t => [t.name, t.tune.repo, t.steps.length])).toEqual([
      ['skill@0.1.0', 'acme/clarinet', 25],
      ['t1', 'acme/clarinet', 25],
      ['t1', 'acme/app', 25],
    ]);
    expect(tunes[0]!.steps[0]!.verdict).toBe('kept');
  });
});
