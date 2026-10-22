import { describe, expect, it } from 'vitest';
import type { rowsOf } from '../bin/bench.ts';
import { bootstrap, cost, defaults, frontier, presets, price, quality, summarise } from '../studio/src/bench/score.ts';

type Row = ReturnType<typeof rowsOf>[number];

const row = (over: Partial<Row>): Row => ({
  point: 'opencode:smart/v2@unknown//runs-3',
  case: 'a',
  repeat: 1,
  strata: { repo: 'me/a' },
  vsHuman: {},
  findings: { critical: 0, high: 0 },
  answers: 0,
  minutes: 1,
  tokens: {},
  usd: 0,
  ...over,
});
const prices = {
  aliases: { smart: 'chatgpt/gpt-6.1-sol' },
  models: { 'gpt-6.1-sol': { input: 1.25, cached: 0.125, output: 10 } },
};

describe('bench score', () => {
  it('puts nothing useful at 0 and the human at 1', () => {
    const nothing = row({ hidden: 0, suite: 0, vsHuman: { opus: 0 } });
    const parity = row({ hidden: 1, suite: 1, vsHuman: { opus: 0.5, sol: 0.5 } });
    expect(quality(nothing, defaults)).toBe(0);
    expect(quality(parity, defaults)).toBeCloseTo(1);
  });

  it('scores a run that changed nothing 0, whatever else it has', () => {
    expect(quality(row({ outcome: 'no-change', hidden: 0, suite: 1, vsHuman: { opus: 0.5 } }), defaults)).toBe(0);
  });

  it('weights the parts a case has, drops judges and charges findings above the human', () => {
    const judged = row({ vsHuman: { opus: 1, sol: 0 } });
    expect(quality(judged, defaults)).toBeCloseTo(1);
    expect(quality(judged, defaults, ['sol'])).toBe(0);
    expect(quality(row({ hidden: 1, vsHuman: { opus: 0 } }), presets['hidden tests only']!)).toBe(1);
    const found = row({ hidden: 1, suite: 1, findings: { critical: 1, high: 2 } });
    const human = row({ findings: { critical: 0, high: 1 } });
    expect(quality(found, defaults, undefined, human)).toBeCloseTo(1 - 0.1 * (2 / 3));
    expect(quality(row({ hidden: 1, answers: 3 }), defaults)).toBeCloseTo(0.9);
  });

  it('takes the share of hidden tests passed over pass or fail when there is one', () => {
    expect(quality(row({ hidden: 0, hiddenShare: 0.5 }), presets['hidden tests only']!)).toBe(0.5);
  });

  it('caps the judge part at the human, so judged and tested parts share one scale', () => {
    expect(quality(row({ vsHuman: { opus: 1, sonnet: 1 } }), defaults)).toBe(1);
    expect(quality(row({ hidden: 0, vsHuman: { opus: 1 } }), defaults)).toBeCloseTo(0.35 / 0.85);
  });

  it('prices tokens by class through the aliases, or falls back to the reported cost', () => {
    const tokens = { smart: { input: 1e6, cacheRead: 1e6, cacheWrite: 0, output: 1e5 } };
    expect(price(tokens, prices)).toBeCloseTo(1.25 + 0.125 + 1);
    expect(price(tokens, prices, true)).toBeCloseTo(1.25 + 1.25 + 1);
    expect(cost(row({ usd: 0.3 }), prices)).toBe(0.3);
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
      row({ point: 'opencode:smart/floor@unknown//runs-3', case: 'a', hidden: 0, suite: 1 }),
      row({ point: 'opencode:smart/human@unknown//runs-3', case: 'a', hidden: 1 }),
    ];
    const s = summarise(rows, { w: defaults, x: r => r.minutes });
    expect(s.map(p => [p.key.split('/')[1], p.n, p.completion])).toEqual([
      ['v2@unknown', 1, 0.5],
      ['floor@unknown', 1, 1],
    ]);
    expect(summarise(rows, { w: defaults, x: r => r.minutes, infraZero: true })[0]!.y).toBeCloseTo(0.5);
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
      row({ case: 'a', strata: { repo: 'me/a', tests: 'hidden' }, hidden: 1 }),
      row({ case: 'b', strata: { repo: 'me/a', tests: 'judge-only' }, vsHuman: { opus: 0 } }),
    ];
    const s = summarise(rows, { w: defaults, x: r => r.minutes });
    expect(s.map(p => [p.key, p.n, p.y])).toEqual([
      ['opencode:smart/v2@unknown//runs-3', 1, 1],
      ['opencode:smart/v2@unknown//runs-3, judge-only', 1, 0],
    ]);
  });
});
