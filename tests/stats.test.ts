import { describe, expect, it } from 'vitest';
import { getMean, getRounded } from '../src/stats.ts';

describe('stats', () => {
  it('gives 0 as the mean of nothing', () => {
    expect(getMean([])).toBe(0);
    expect(getMean([1, 2])).toBe(1.5);
  });

  it('rounds to three decimals', () => {
    expect(getRounded(1 / 3)).toBe(0.333);
  });
});
