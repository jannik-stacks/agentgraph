import { mkdirSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { makeStudioDevApiPlugin } from '../studio/fixtures.ts';
import { makeStudioPagesPlugin } from '../studio/plugins.ts';
import type { BenchData } from '../studio/src/bench/data.ts';
import { readBenchRowResults } from '../studio/src/results/result.ts';
import type { readBenchRows } from '../bin/bench.ts';
import { tmp } from './kit.ts';
import {
  bootstrap,
  cost,
  defaultBenchScoreWeights,
  frontier,
  getQuantile,
  presets,
  quality,
  summarise,
} from '../studio/src/bench/score.ts';

type Row = ReturnType<typeof readBenchRows>[number];

const row = (over: Partial<Row>): Row => ({
  labels: { harness: 'opencode', model: 'smart', arm: 'v2', engine: 'unknown', graph: '', set: 'runs-3', repo: 'me/a' },
  case: 'a',
  repeat: 1,
  vsHuman: {},
  findings: { critical: 0, high: 0 },
  answers: 0,
  minutes: 1,
  tokens: {},
  usd: 0,
  usdUncached: 0,
  checkUsd: 0,
  ...over,
});

describe('bench score', () => {
  it('leaves a row with nothing to score unscored instead of treating it as zero quality', () => {
    expect(quality(row({}), defaultBenchScoreWeights)).toBeUndefined();
  });

  it('leaves rows with nothing to score out of the point and its counts', () => {
    const rows = [row({ case: 'a', hidden: 1, suite: 1 }), row({ case: 'b' }), row({ case: 'a', repeat: 2 })];
    const [p] = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes });
    expect([p!.y, p!.n, p!.repeats, p!.perCase.map(s => s.row.case)]).toEqual([1, 1, 1, ['a']]);
  });

  it('puts nothing useful at 0 and the human at 1', () => {
    const nothing = row({ hidden: 0, suite: 0, vsHuman: { opus: 0 } });
    const parity = row({ hidden: 1, suite: 1, vsHuman: { opus: 0.5, sol: 0.5 } });
    expect(quality(nothing, defaultBenchScoreWeights)).toBe(0);
    expect(quality(parity, defaultBenchScoreWeights)).toBeCloseTo(1);
  });

  it('scores a run that changed nothing 0, whatever else it has', () => {
    expect(
      quality(row({ outcome: 'no-change', hidden: 0, suite: 1, vsHuman: { opus: 0.5 } }), defaultBenchScoreWeights)
    ).toBe(0);
  });

  it('weights the parts a case has, drops judges and charges findings above the human', () => {
    const judged = row({ vsHuman: { opus: 1, sol: 0 } });
    expect(quality(judged, defaultBenchScoreWeights)).toBeCloseTo(1);
    expect(quality(judged, defaultBenchScoreWeights, ['sol'])).toBe(0);
    expect(quality(row({ hidden: 1, vsHuman: { opus: 0 } }), presets['hidden tests only']!)).toBe(1);
    const found = row({ hidden: 1, suite: 1, findings: { critical: 1, high: 2 } });
    const human = row({ findings: { critical: 0, high: 1 } });
    expect(quality(found, defaultBenchScoreWeights, undefined, human)).toBeCloseTo(1 - 0.1 * (2 / 3));
    expect(quality(row({ hidden: 1, answers: 3 }), defaultBenchScoreWeights)).toBeCloseTo(0.9);
  });

  it('takes the share of hidden tests passed over pass or fail when there is one', () => {
    expect(quality(row({ hidden: 0, hiddenShare: 0.5 }), presets['hidden tests only']!)).toBe(0.5);
  });

  it('caps the judge part at the human, so judged and tested parts share one scale', () => {
    expect(quality(row({ vsHuman: { opus: 1, sonnet: 1 } }), defaultBenchScoreWeights)).toBe(1);
    expect(quality(row({ hidden: 0, vsHuman: { opus: 1 } }), defaultBenchScoreWeights)).toBeCloseTo(0.35 / 0.85);
  });

  it('costs a row at list price, with or without its cache reads', () => {
    expect(cost(row({ usd: 0.3, usdUncached: 0.5 }))).toBe(0.3);
    expect(cost(row({ usd: 0.3, usdUncached: 0.5 }), true)).toBe(0.5);
  });

  it('takes the median and quartiles between case means, whatever their order', () => {
    expect([0.25, 0.5, 0.75].map(q => getQuantile([1, 0, 0.5, 0.25], q))).toEqual([0.1875, 0.375, 0.625]);
    expect(getQuantile([0.4], 0.5)).toBe(0.4);
  });

  it('bootstraps cases then repeats the same way for the same seed', () => {
    const cases = [
      [
        { y: 0, x: 1 },
        { y: 1, x: 3 },
      ],
      [{ y: 1, x: 2 }],
      [{ y: 0.5, x: 1 }],
    ];
    const a = bootstrap(cases);
    expect(a).toEqual(bootstrap(cases));
    expect(a.y).toBeCloseTo(2 / 3);
    expect(a.x).toBeCloseTo(5 / 3);
    expect(a.yCi[0]).toBeLessThanOrEqual(a.y);
    expect(a.yCi[1]).toBeGreaterThanOrEqual(a.y);
  });

  it('summarises points without the human, with completion, and keeps the non-dominated ones', () => {
    const rows = [
      row({ case: 'a', hidden: 1, suite: 1 }),
      row({ case: 'b', infra: 'docker unreachable' }),
      row({ labels: { ...row({}).labels, arm: 'floor' }, case: 'a', hidden: 0, suite: 1 }),
      row({ labels: { ...row({}).labels, arm: 'human' }, case: 'a', hidden: 1 }),
    ];
    const s = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes });
    expect(s.map(p => [p.labels.arm, p.n, p.completion])).toEqual([
      ['v2', 1, 0.5],
      ['floor', 1, 1],
    ]);
    expect(summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes, infraZero: true })[0]!.y).toBeCloseTo(0.5);
    const points = [
      { key: 'cheap', x: 1, y: 0.2 },
      { key: 'worse', x: 2, y: 0.1 },
      { key: 'better', x: 3, y: 0.8 },
      { key: 'tied', x: 4, y: 0.8 },
    ];
    expect(frontier(points)).toEqual(['cheap', 'better']);
  });

  it('reports judge-only cases as their own point, never averaged with tested ones', () => {
    const rows = [
      row({ case: 'a', labels: { ...row({}).labels, tests: 'hidden' }, hidden: 1 }),
      row({ case: 'b', labels: { ...row({}).labels, tests: 'judge-only' }, vsHuman: { opus: 0 } }),
    ];
    const s = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes });
    expect(s.map(p => [p.labels.tests, p.n, p.y])).toEqual([
      ['hidden', 1, 1],
      ['judge-only', 1, 0],
    ]);
    expect(s.map(p => p.judgeOnly)).toEqual([false, true]);
    expect(frontier([...s.map(p => ({ ...p, x: 2 })), { key: 'cheap', x: 1, y: 0.5 }])).toEqual(['cheap', s[0]!.key]);
  });
  it('filters any label, groups and colours independently, and retains the matching human baseline', () => {
    const labels = { ...row({}).labels, size: 'S', skills: 'true' };
    const rows = [
      row({ labels: { ...labels, arm: 'human', graph: '' }, findings: { critical: 3, high: 0 } }),
      row({ labels, hidden: 1, findings: { critical: 3, high: 0 } }),
      row({ labels: { ...labels, repo: 'me/b', skills: 'false' }, case: 'b', hidden: 0 }),
      row({ labels: { ...labels, size: 'L' }, case: 'c', hidden: 0 }),
    ];
    const lens = { w: defaultBenchScoreWeights, x: (r: Row) => r.minutes, by: ['size'], color: 'skills' };
    const filtered = summarise(rows, { ...lens, where: { arm: ['v2'], size: ['S'], repo: ['me/a'] } });
    expect(filtered.map(p => [p.labels, p.n, p.y])).toEqual([[{ size: 'S', skills: 'true', set: 'runs-3' }, 1, 1]]);
    expect(summarise(rows, lens).map(p => p.n)).toEqual([1, 1, 1]);
    expect(summarise(rows, { ...lens, color: '' }).map(p => p.n)).toEqual([2, 1]);
    const other = row({ labels: { ...labels, set: 'core' }, case: 'd', hidden: 1 });
    expect(summarise([...rows, other], { ...lens, by: [], color: '' }).map(p => p.labels.set)).toEqual([
      'runs-3',
      'core',
    ]);
  });

  it('matches human findings within each repeat and avoids delimiter collisions', () => {
    const labels = row({}).labels;
    const rows = [
      row({ labels: { ...labels, arm: 'human' }, findings: { critical: 0, high: 0 } }),
      row({ labels: { ...labels, arm: 'human' }, repeat: 2, findings: { critical: 3, high: 0 } }),
      row({ repeat: 2, hidden: 1, findings: { critical: 3, high: 0 } }),
      row({ labels: { ...labels, repo: 'a,b', size: 'c' }, case: 'b', hidden: 1 }),
      row({ labels: { ...labels, repo: 'a', size: 'b,c' }, case: 'c', hidden: 0 }),
    ];
    const points = summarise(rows, { w: defaultBenchScoreWeights, x: r => r.minutes, by: ['repo', 'size'] });
    expect(points.map(p => p.y)).toEqual([1, 1, 0]);
  });
  it('preserves every free label in Results, with distinct identities for combined setups', () => {
    const labels = { ...row({}).labels, point: 'experiment', case: 'category', hiddenTests: 'custom' };
    const result = readBenchRowResults(row({ labels, skipped: 'no hidden tests' }));
    const other = readBenchRowResults(row({ labels: { ...labels, model: 'other' } }));
    expect(result.axes).toMatchObject(labels);
    expect(other.key).not.toBe(result.key);
  });
});

describe('the bench page data', () => {
  it('rejects a failed scan, keeps rows until a log changes and links each arm to its runs', async () => {
    const out = tmp('bench-api');
    const at = (...path: string[]) => join(out, 'c', ...path);
    mkdirSync(at('human'), { recursive: true });
    mkdirSync(at('v2', 'data', 'issue-1'), { recursive: true });
    mkdirSync(at('v2', 'data', 'logs'));
    writeFileSync(at('v2', 'data', 'issue-1', 'run.json'), '{}');
    writeFileSync(join(out, 'log.jsonl'), '');
    writeFileSync(at('case.json'), JSON.stringify({ repo: 'me/demo' }));
    writeFileSync(at('human', 'score.json'), '{');
    vi.stubEnv('AGI_STUDIO_DIR', undefined);
    vi.stubEnv('AGI_STUDIO_BENCH', out);
    const routes: Record<string, (req: unknown, res: unknown) => void> = {};
    const plugin = makeStudioPagesPlugin().configureServer as (server: unknown) => Promise<void>;
    await plugin({
      watcher: { add: () => {}, on: () => {}, off: () => {} },
      middlewares: { use: (path: string, f: (typeof routes)[string]) => (routes[path] = f) },
    });
    const ask = () =>
      new Promise<{ status: number; body: BenchData }>(done => {
        const res = {
          statusCode: 200,
          setHeader: () => {},
          end: (body: string) => done({ status: res.statusCode, body: JSON.parse(body) }),
        };
        routes['/api/plugins']!({ url: '/bench/data', method: 'GET' }, res);
      });
    try {
      expect((await ask()).status).toBe(500);
      writeFileSync(at('human', 'score.json'), '{}');
      expect((await ask()).body.rows).toHaveLength(1);
      writeFileSync(at('v2', 'score.json'), '{}');
      expect((await ask()).body.rows).toHaveLength(1);
      utimesSync(join(out, 'log.jsonl'), new Date(), new Date(Date.now() + 1000));
      const { rows, drives } = (await ask()).body;
      expect(rows.map(r => r.runs)).toEqual([undefined, ['issue-1']]);
      expect(rows[1]!.data).toBe(at('v2', 'data'));
      expect(drives).toEqual([]);
    } finally {
      vi.unstubAllEnvs();
      rmSync(out, { recursive: true, force: true });
    }
  });
});

describe('/api/runs with a bench data dir', () => {
  it('reads runs only from inside the bench dirs', async () => {
    const out = tmp('bench-runs');
    mkdirSync(join(out, 'c', 'v2', 'data'), { recursive: true });
    vi.stubEnv('AGI_STUDIO_DIR', undefined);
    vi.stubEnv('AGI_STUDIO_BENCH', out);
    const routes: Record<string, (req: unknown, res: unknown) => void> = {};
    const plugin = makeStudioDevApiPlugin().configureServer as (server: unknown) => void;
    plugin({ middlewares: { use: (path: string, f: (typeof routes)[string]) => (routes[path] = f) } });
    const ask = (url: string) =>
      new Promise<{ status: number; body: unknown }>(done => {
        const res = {
          statusCode: 200,
          setHeader: () => {},
          end: (body: string) => done({ status: res.statusCode, body: JSON.parse(body) }),
        };
        routes['/api/runs']!({ url }, res);
      });
    try {
      expect(await ask(`/?data=${encodeURIComponent(join(out, '..'))}`)).toMatchObject({ status: 400 });
      expect(await ask(`/?data=${encodeURIComponent(join(out, 'c', 'v2', 'data'))}`)).toEqual({
        status: 200,
        body: [],
      });
    } finally {
      vi.unstubAllEnvs();
      rmSync(out, { recursive: true, force: true });
    }
  });
});
