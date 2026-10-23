import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import {
  cheaper,
  decide,
  type Flip,
  flipsOf,
  guard,
  init,
  paired,
  propose,
  run,
  status,
  step,
  tuneRows,
  type tunesOf,
} from '../bin/tune.ts';
import { fixtures } from '../studio/fixtures.ts';
import { tmp } from './kit.ts';

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
  delete process.env.AGENTGRAPH_TUNE;
  delete process.env.VITE_AGI_TUNE;
});

const evalOf = (flips: Record<string, Flip> = {}): Parameters<typeof decide>[1] => ({
  candidate: 'c',
  split: 'fit',
  cases: [],
  quality: 0,
  ci: [0, 0],
  flips,
  usd: 0,
  minutes: 0,
  codex: 0,
  claude5h: 0,
});

describe('paired, flips and decide', () => {
  it('measures the gain of b over a case by case', () => {
    expect(paired([0, 0, 0, 0], [1, 1, 1, 1])).toEqual({ delta: 1, pUp: 1, ci: [1, 1] });
    expect(paired([1, 0, 1, 0], [1, 0, 1, 0])).toEqual({ delta: 0, pUp: 0, ci: [0, 0] });
    const mixed = paired([0, 0, 0, 0, 0], [1, 1, 1, 0, -1]);
    expect(mixed.delta).toBe(0.4);
    expect(mixed.pUp).toBeGreaterThan(0.8);
    expect(mixed.ci[0]).toBeLessThan(0.4);
    expect(paired([], [])).toEqual({ delta: 0, pUp: 0, ci: [0, 0] });
  });

  it('flips a case only off an incumbent whose runs agree, and calls it held after enough runs', () => {
    const inc = { a: [0.13], b: [1, 1, 1], c: [1, 0.13], d: [0.13, 0.13, 0.13], e: [1], f: [0.87] };
    const cand = { a: [1], b: [0.13, 0.13, 0.13], c: [0.13], d: [1, 1, 0.13], e: [1], f: [1] };
    expect(flipsOf(inc, cand, 3)).toEqual({ a: 'up', b: 'loss', d: 'up' });
    expect(flipsOf({ a: [0.13, 0.13, 0.13] }, { a: [1, 1, 1] }, 3)).toEqual({ a: 'win' });
    expect(flipsOf({ a: [0.13] }, { a: [] }, 3)).toEqual({});
  });

  it('screens out two drops and keeps more wins than losses', () => {
    const t = { keep: { runs: 3, drops: 2 } };
    expect(decide(t, evalOf({ a: 'down', b: 'down' }))).toBe('screened-out');
    expect(decide(t, evalOf({ a: 'down', b: 'down', c: 'up' }))).toBe('discarded');
    expect(decide(t, evalOf({ a: 'down' }))).toBe('discarded');
    expect(decide(t, evalOf({ a: 'down' }), evalOf({ a: 'win' }))).toBe('kept');
    expect(decide(t, evalOf(), evalOf({ a: 'win', b: 'loss' }))).toBe('discarded');
    expect(decide(t, evalOf(), evalOf({ a: 'up' }))).toBe('discarded');
    expect(decide({ keep: {} }, evalOf({ a: 'down', b: 'loss' }))).toBe('screened-out');
  });

  it('keeps a candidate that drops no case and surely costs less', () => {
    const t = { keep: {} };
    const saved = (usd: number, pDown: number) => ({ usd: { share: usd, pDown }, minutes: { share: 0, pDown: 0 } });
    const full = (flips: Record<string, Flip>, s: ReturnType<typeof saved>) => ({ ...evalOf(flips), saved: s });
    expect(cheaper(t, full({}, saved(0.2, 0.97)))).toEqual(['usd']);
    expect(decide(t, evalOf(), full({}, saved(0.2, 0.97)))).toBe('kept');
    expect(decide(t, evalOf(), full({}, saved(0.1, 0.99)))).toBe('discarded');
    expect(decide(t, evalOf(), full({}, saved(0.3, 0.8)))).toBe('discarded');
    expect(decide(t, evalOf(), full({ a: 'down' }, saved(0.3, 0.99)))).toBe('discarded');
    expect(decide(t, evalOf(), full({ a: 'win', b: 'loss' }, saved(0.3, 0.99)))).toBe('discarded');
  });

  /** Equal hubs whose per-run cost varies by a lognormal factor of about 35% must almost never pass as cheaper. */
  it('rarely calls an equal hub cheaper on noisy run costs', () => {
    let seed = 7;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const noise = () => Math.exp(0.35 * Math.sqrt(-2 * Math.log(rnd() || 1e-9)) * Math.cos(2 * Math.PI * rnd()));
    const rate = (n: number, factor: number) => {
      let kept = 0;
      for (let i = 0; i < 400; i++) {
        const s = Array.from({ length: n }, () => Math.round((1 - (factor * noise()) / noise()) * 1000) / 1000);
        const p = paired(
          s.map(() => 0),
          s
        );
        kept += +(
          cheaper(
            { keep: {} },
            { ...evalOf(), saved: { usd: { share: p.delta, pDown: p.pUp }, minutes: { share: 0, pDown: 0 } } }
          ).length > 0
        );
      }
      return kept / 400;
    };
    for (const n of [6, 10]) expect(rate(n, 1)).toBeLessThan(0.05);
    expect(rate(10, 0.6)).toBeGreaterThan(0.7);
  });

  /**
   * Replays the step on simulated cases: a stable case passes 97% or 3% of runs, a flaky one 30% or 70%. A
   * candidate equal to the incumbent must almost never be kept; one that fixes one stable failing case usually is.
   */
  it('rarely keeps a candidate equal to the incumbent and usually keeps one clean fix', () => {
    let seed = 11;
    const rnd = () => (seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31;
    const t = { keep: { runs: 3, drops: 2 } };
    const trial = (n: number, flaky: number, fix: boolean) => {
      const ps = Array.from({ length: n }, (_, i) =>
        i === n - 1 ? 0.03 : rnd() < flaky ? (rnd() < 0.5 ? 0.3 : 0.7) : rnd() < 0.5 ? 0.03 : 0.97
      );
      const run = (p: number) => (rnd() < p ? 1 : 0.13);
      const mine = (i: number) => (fix && i === n - 1 ? 0.97 : ps[i]!);
      const inc: Record<string, number[]> = Object.fromEntries(ps.map((p, i) => [i, [run(p)]]));
      const cand: Record<string, number[]> = {};
      const on = (cases: number[]) => Object.fromEntries(cases.map(i => [i, cand[i]!]));
      const screen = [0, 1, 2, 3];
      for (const i of screen) cand[i] = [run(mine(i))];
      const s = evalOf(flipsOf(inc, on(screen), 3));
      if (decide(t, s) === 'screened-out') return false;
      for (let i = 4; i < n; i++) cand[i] = [run(mine(i))];
      const all = ps.map((_, i) => i);
      const f = flipsOf(inc, on(all), 3);
      if (Object.values(f).includes('up'))
        for (const k of Object.keys(f).filter(k => f[k] === 'up' || f[k] === 'down')) {
          while (cand[k]!.length < 3) cand[k]!.push(run(mine(+k)));
          while (inc[k]!.length < 3) inc[k]!.push(run(ps[+k]!));
        }
      return decide(t, s, evalOf(flipsOf(inc, on(all), 3))) === 'kept';
    };
    const rate = (n: number, flaky: number, fix: boolean) => {
      let kept = 0;
      for (let i = 0; i < 4000; i++) kept += +trial(n, flaky, fix);
      return kept / 4000;
    };
    for (const n of [6, 14]) {
      expect(rate(n, 0.25, false)).toBeLessThan(0.04);
      expect(rate(n, 0.5, false)).toBeLessThan(0.07);
      expect(rate(n, 0.25, true)).toBeGreaterThan(0.7);
    }
  });
});

/** A bench stand-in: a case passes when the candidate hub has `skills/<case>.md` or `skills/all.md`. */
const fakeBench = (ran: { id: string; case: string; repeat?: number }[]) => ({
  run: async (_dir: string, _t: unknown, jobs: typeof ran) => void ran.push(...jobs),
  rows: (dir: string, id: string) =>
    ran
      .filter(j => j.id === id)
      .map(j => ({
        point: 'opencode:luna/v2@e/h/s',
        case: j.case,
        repeat: j.repeat ?? 1,
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
  process.env.AGENTGRAPH_TUNE = join(root, 'tune');
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
    const ran: Parameters<typeof fakeBench>[0] = [];
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
      ['i001-manual', 'kept'],
    ]);
    expect(tuneRows(dir).steps[1]!.why).toMatch(/won f1, lost none/);
    expect(tuneRows(dir).steps[1]!.evals[0]!.flips).toEqual({ f1: 'win' });
    expect(ran.filter(j => j.repeat).map(j => [j.id, j.case, j.repeat])).toEqual([
      ['i000-init', 'f1', 2],
      ['i000-init', 'f1', 3],
      ['i001-manual', 'f1', 2],
      ['i001-manual', 'f1', 3],
    ]);

    const made = await step(dir, { k: 3, proposers: ['retro', 'history'] }, io);
    expect(made.map(s => [s.id, s.verdict])).toEqual([
      ['i002-retro', 'kept'],
      ['i002-history', 'discarded'],
    ]);
    const retro = made.find(s => s.id === 'i002-retro')!;
    expect(retro.evals.map(e => [e.split, e.cases.length, e.delta])).toEqual([
      ['fit', 4, 0.75],
      ['validate', 2, 1],
    ]);
    expect(retro.diff).toContain('skills/all.md');
    expect(retro.why).toMatch(/won f2, f3, f4, v1, v2, lost none, delta 0.833 over 6 cases/);
    expect(made[1]!.why).toMatch(/won none, lost none, delta 0 over 6 cases, usd 0 .*, below the bar/);
    expect(JSON.parse(readFileSync(join(dir, 'budget.json'), 'utf8')).claude.week).toEqual({ now: 50, used: 0 });

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

    await run(dir, { iterations: 5, until: 3, proposers: ['retro'] }, io);
    expect(ran.length).toBe(before);
    const down = {
      ...io,
      propose: async () => {
        throw new Error('claude unreachable');
      },
    } as unknown as typeof io;
    await expect(step(dir, { k: 1, proposers: ['retro'] }, down)).rejects.toThrow(/every proposer failed/);
    expect(ran.length).toBe(before);

    let asked = 0;
    const silent = { ...io, propose: async () => (asked++, { rationale: 'nothing' }) } as unknown as typeof io;
    await run(dir, { iterations: 5, proposers: ['retro'] }, silent);
    expect(asked).toBe(1);

    propose(dir, fromHub, 'f1 needs care, on a broken bench');
    const broken = {
      ...silent,
      rows: (d: string, id: string) =>
        fakeBench(ran)
          .rows(d, id)
          .map(r => ({ ...r, infra: 'setup fails' })),
    } as unknown as typeof io;
    asked = 0;
    await run(dir, { iterations: 5, proposers: ['retro'] }, broken);
    expect(tuneRows(dir).steps.at(-1)!.verdict).toBe('infra');
    expect(asked).toBe(1);
  });
});

describe('usage', () => {
  it('counts usage across a window reset and stops past a cap', () => {
    const dir = tmp('guard');
    dirs.push(dir);
    const limits = { codex: 100, claude5h: 100, claudeWeek: 100 };
    const at = (codex: number, fiveHour: number) => guard(dir, { codex: () => codex }, limits, { fiveHour, week: 10 });
    at(10, 50);
    at(30, 80);
    const b = at(5, 10);
    expect(b.codex).toEqual({ now: 5, used: 25 });
    expect(b.claude?.fiveHour).toEqual({ now: 10, used: 40 });
    expect(b.claude?.week).toEqual({ now: 10, used: 0 });
    expect(() => guard(dir, { codex: () => 30 }, { ...limits, codex: 40 })).toThrow(/Codex weekly used 50 points/);
  });

  it('books every Codex point a step or the start spends once, on one of its evals', async () => {
    const ran: Parameters<typeof fakeBench>[0] = [];
    let codex = 0;
    const io = { ...fakeBench(ran), codex: () => (codex += 4) } as unknown as Parameters<typeof step>[2];
    const dir = await init('demo', setup(), io);
    const spent = (id: string) =>
      tuneRows(dir)
        .steps.filter(s => s.id === id)
        .flatMap(s => s.evals)
        .reduce((a, e) => a + e.codex, 0);
    expect(spent('i000-init')).toBe(4);
    const hub = join(dir, '..', 'draft');
    spawnSync('cp', ['-R', join(dir, 'cands/i000-init/hub'), hub]);
    mkdirSync(join(hub, 'skills'));
    writeFileSync(join(hub, 'skills', 'f1.md'), 'Mind f1.\n');
    propose(dir, hub, 'f1 needs care');
    const limits = { codex: 100, claude5h: 100, claudeWeek: 100 };
    await step(dir, { k: 1, proposers: ['manual'], limits }, io);
    expect(spent('i001-manual')).toBe(12);
  });
});

describe('status', () => {
  it('sums a tune up on one screen', () => {
    const text = status(join(import.meta.dirname, 'fixtures/tune/clarinet/skill@0.1.0'));
    expect(text).toContain('incumbent i006-skill-1');
    expect(text).toContain('quality, human = 1: select 0.655 on 14, validate 0.657 on 4, test 0.924 on 5');
    expect(text).toContain('points used: Codex - of 25, Claude 5h - of 40, Claude week - of 12');
    expect(text).toContain('no log yet');
  });
});

const tuneRoot = (dir: string) => join(dir, '..', '..');

describe('/api/compound', () => {
  it('answers every tune under VITE_AGI_TUNE with its steps', async () => {
    const routes: Record<string, (req: unknown, res: unknown) => Promise<void>> = {};
    const plugin = fixtures().configureServer as (server: unknown) => void;
    plugin({ middlewares: { use: (path: string, f: (typeof routes)[string]) => (routes[path] = f) } });
    process.env.VITE_AGI_TUNE = join(import.meta.dirname, 'fixtures/tune');
    let body = '';
    await routes['/api/compound']!({}, { setHeader: () => {}, end: (b: string) => (body = b) });
    const tunes = JSON.parse(body) as ReturnType<typeof tunesOf>;
    expect(tunes.map(t => [t.name, t.tune.repo, t.steps.length])).toEqual([
      ['skill@0.1.0', 'acme/clarinet', 25],
      ['t1', 'acme/clarinet', 25],
      ['t1', 'example-org/kit', 25],
    ]);
    expect(tunes[0]!.steps[0]!.verdict).toBe('kept');
  });
});
