import { describe, expect, it } from 'vitest';
import { getMean, getQuantile, getRounded, sumSpend } from '../src/stats.ts';

describe('stats', () => {
  it('has no mean or quantile of nothing', () => {
    expect(getMean([])).toBeUndefined();
    expect(getMean([1, 2])).toBe(1.5);
    expect(getQuantile([], 0.5)).toBeUndefined();
    expect(getQuantile([0], 0.5)).toBe(0);
  });

  it('rounds to three decimals', () => {
    expect(getRounded(1 / 3)).toBe(0.333);
  });

  it('sums known spend and keeps the first unpriced model', () => {
    expect(sumSpend([])).toEqual({ usd: 0 });
    expect(sumSpend([{ usd: 0.5 }, { usd: 0.25 }])).toEqual({ usd: 0.75 });
    expect(sumSpend([{ usd: 0.5 }, { unpriced: 'm1' }, { usd: 0, unpriced: 'm2' }])).toEqual({
      usd: 0.5,
      unpriced: 'm1',
    });
  });
});
