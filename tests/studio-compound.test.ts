import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import * as c from '../studio/src/compound/climb.ts';
import type { Step, TuneRows } from '../studio/src/compound/climb.ts';

const dir = join(import.meta.dirname, 'fixtures', 'tune');
const fixture = (): TuneRows[] =>
  readdirSync(dir).flatMap(repo =>
    readdirSync(join(dir, repo)).map(name => ({
      name,
      tune: JSON.parse(readFileSync(join(dir, repo, name, 'tune.json'), 'utf8')),
      steps: readFileSync(join(dir, repo, name, 'iterations.jsonl'), 'utf8')
        .trim()
        .split('\n')
        .map(l => JSON.parse(l)),
    }))
  );

const evalOf = (split: Step['evals'][number]['split'], n: number, quality: number, usd = 1) => ({
  candidate: 'x',
  split,
  cases: Array.from({ length: n }, (_, i) => `c${i}`),
  quality,
  ci: [quality, quality] as [number, number],
  usd,
  minutes: 1,
  codex: 0.5,
  claude5h: 0.25,
});
const step = (iteration: number, verdict: Step['verdict'], q: number, at = `${iteration}`): Step => ({
  id: `i${iteration}-${at}`,
  iteration,
  parent: 'p',
  proposer: 'retro',
  hub: 'h',
  rationale: '',
  diff: '',
  evals: [evalOf('fit', 4, q)],
  verdict,
  why: '',
  at,
});
const tune = (repo: string, name: string, steps: Step[]): TuneRows => ({
  name,
  tune: {
    repo,
    engine: 'e',
    point: 'p',
    cases: {},
    preset: 'hidden',
    keep: { runs: 3, drops: 2 },
    clone: '',
  },
  steps,
});

describe('compound climb', () => {
  it('scores a step case-weighted over fit and validate, leaving test out', () => {
    const s = {
      ...step(1, 'kept', 0),
      evals: [evalOf('fit', 6, 0.5), evalOf('validate', 2, 0.9), evalOf('test', 5, 2)],
    };
    expect(c.score(s)).toBeCloseTo(0.6);
    expect(c.score(s, ['test'])).toBe(2);
    expect(c.score({ ...s, evals: [] })).toBeUndefined();
  });

  it('draws the running best through kept points only, never down, on to the last point', () => {
    const best = c.runningBest([
      { x: 0, y: 0.4, kept: true },
      { x: 1, y: 0.9, kept: false },
      { x: 2, y: 0.5, kept: true },
      { x: 3, y: 0.45, kept: true },
      { x: 4, y: undefined, kept: false },
    ]);
    expect(best).toEqual([
      { x: 0, y: 0.4 },
      { x: 2, y: 0.5 },
      { x: 4, y: 0.5 },
    ]);
  });

  it('builds one series per tune, steps in order, with cumulative usd, loop tunes before skill ones', () => {
    const series = c.seriesOf([
      tune('me/a', 'skill@0.1.0', [step(0, 'kept', 0.4)]),
      tune('me/a', 't1', [step(1, 'discarded', 0.3, 'b'), step(0, 'kept', 0.4), step(1, 'kept', 0.5, 'a')]),
    ]);
    expect(series.map(s => [s.key, s.skill])).toEqual([
      ['me/a/t1', false],
      ['me/a/skill@0.1.0', true],
    ]);
    const [t1] = series;
    expect(t1!.points.map(p => p.step.id)).toEqual(['i0-0', 'i1-a', 'i1-b']);
    expect(t1!.points.map(p => p.cum)).toEqual([1, 2, 3]);
    expect(t1!.init).toBe(0.4);
    expect(c.byIteration(t1!).map(r => [r.best, r.usd, r.cum])).toEqual([
      [0.4, 1, 1],
      [0.5, 2, 3],
    ]);
  });

  it('averages the running best over repos per iteration, holding a tune that stopped early', () => {
    const series = c.seriesOf([
      tune('me/a', 't1', [step(0, 'kept', 0.4), step(1, 'kept', 0.6), step(2, 'kept', 0.8)]),
      tune('me/b', 't1', [step(0, 'kept', 0.6), step(1, 'discarded', 0.9)]),
      tune('me/a', 'skill@0.1.0', [step(0, 'kept', 0.4)]),
    ]);
    const [loop, skill] = c.average(series);
    expect(loop!.name).toBe('t1');
    expect(loop!.repos).toBe(2);
    expect(loop!.rows.map(r => [r.best, r.lo, r.hi].map(v => Math.round(v! * 100) / 100))).toEqual([
      [0.5, 0.4, 0.6],
      [0.6, 0.6, 0.6],
      [0.7, 0.6, 0.8],
    ]);
    expect(loop!.rows[2]!.usd).toBe(1);
    expect(skill!.rows.map(r => r.best)).toEqual([0.4]);
  });

  it('leaves the best out until a repo keeps a score, so no point is drawn from nothing', () => {
    const series = c.seriesOf([
      tune('me/a', 't1', [step(0, 'discarded', 0.4), step(1, 'kept', 0.6)]),
      tune('me/b', 't1', [step(0, 'discarded', 0.5), step(1, 'discarded', 0.7)]),
    ]);
    expect(c.byIteration(series[0]!).map(r => r.best)).toEqual([undefined, 0.6]);
    const [loop] = c.average(series);
    expect(loop!.rows.map(r => [r.best, r.lo, r.hi])).toEqual([
      [undefined, undefined, undefined],
      [0.6, 0.6, 0.6],
    ]);
  });

  it('puts steps on hours since the first and holds the kept value per run as a staircase', () => {
    const at = (h: number) => new Date(Date.UTC(2026, 9, 1, h)).toISOString();
    const priced = (iteration: number, verdict: Step['verdict'], h: number, usd: number): Step => ({
      ...step(iteration, verdict, 0.5, at(h)),
      evals: [{ ...evalOf('fit', 4, 0.5, 4 * usd), perRun: { usd, minutes: 10 } }, evalOf('validate', 2, 0.5, 2)],
    });
    const [s] = c.seriesOf([
      tune('me/a', 't2', [priced(0, 'kept', 0, 0.3), priced(1, 'discarded', 3, 0.1), priced(2, 'kept', 5, 0.2)]),
    ]);
    expect(s!.points.map(p => p.hours)).toEqual([0, 3, 5]);
    expect(s!.points[0]!.run.usd).toBeCloseTo((4 * 0.3 + 2 * 1) / 6);
    expect(s!.points[0]!.run.minutes).toBeCloseTo((4 * 10 + 2 * 0.5) / 6);
    const line = c.incumbent([
      { x: 0, y: 0.3, kept: true },
      { x: 3, y: 0.1, kept: false },
      { x: 5, y: 0.35, kept: true },
      { x: 7, y: 0.2, kept: false },
    ]);
    expect(line).toEqual([
      { x: 0, y: 0.3 },
      { x: 5, y: 0.35 },
      { x: 7, y: 0.35 },
    ]);
  });

  it('reads the fixture: two repos, a skill series, and a climb on each', () => {
    const series = c.seriesOf(fixture());
    expect(new Set(series.map(s => s.repo)).size).toBe(2);
    expect(series.some(s => s.skill)).toBe(true);
    for (const s of series) {
      const rows = c.byIteration(s);
      expect(rows.at(-1)!.best).toBeGreaterThan(s.init!);
    }
  });
});
