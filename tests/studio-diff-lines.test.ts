import { describe, expect, it } from 'vitest';
import {
  changedSpans,
  columnOf,
  emphasisOf,
  hunksOf,
  type Kind,
  pairLines,
} from '../studio/src/dashboard/diff-lines.ts';

const kinds = (...list: Kind[]) => list.map(kind => ({ kind }));

describe('pairLines', () => {
  it('pairs each removed line with the added line in the same position of the run after it', () => {
    const pairs = pairLines(kinds('ctx', 'del', 'del', 'add', 'add', 'ctx'));
    expect([...pairs].toSorted(([a], [b]) => a - b)).toEqual([
      [1, 3],
      [2, 4],
      [3, 1],
      [4, 2],
    ]);
  });

  it('leaves the extra lines of an uneven run unpaired', () => {
    const pairs = pairLines(kinds('del', 'del', 'del', 'add'));
    expect(pairs.get(0)).toBe(3);
    expect(pairs.has(1)).toBe(false);
    expect(pairs.has(2)).toBe(false);
    const more = pairLines(kinds('del', 'add', 'add'));
    expect(more.get(0)).toBe(1);
    expect(more.has(2)).toBe(false);
  });

  it('pairs nothing across a context line or for lines only added or only removed', () => {
    expect(pairLines(kinds('del', 'ctx', 'add')).size).toBe(0);
    expect(pairLines(kinds('add', 'del')).size).toBe(0);
    expect(pairLines(kinds('add', 'add', 'ctx', 'del')).size).toBe(0);
  });

  it('pairs each run of a hunk on its own', () => {
    const pairs = pairLines(kinds('del', 'add', 'ctx', 'del', 'add'));
    expect(pairs.get(0)).toBe(1);
    expect(pairs.get(3)).toBe(4);
  });
});

describe('changedSpans', () => {
  it('marks what differs between the shared start and end', () => {
    expect(changedSpans('const a = 1;', 'const a = 42;')).toEqual({ del: [[10, 11]], add: [[10, 12]] });
  });

  it('marks only the inserted side of a pure insertion', () => {
    expect(changedSpans('foo(a)', 'foo(a, b)')).toEqual({ del: [], add: [[5, 8]] });
  });

  it('marks nothing on identical lines', () => {
    expect(changedSpans('same', 'same')).toEqual({ del: [], add: [] });
  });

  it('gives up when less than the cutoff of the text is unchanged', () => {
    expect(changedSpans('return value;', 'throw new Error();')).toBeUndefined();
    expect(changedSpans('abcdefghij', 'abXXXXXXXX')).toBeUndefined();
    expect(changedSpans('abcdefghij', 'abcdXXXXXX')).toEqual({ del: [[4, 10]], add: [[4, 10]] });
  });
});

describe('columnOf', () => {
  it('counts tabs to the next tab stop', () => {
    expect(columnOf('\tx', 1)).toBe(4);
    expect(columnOf('ab\tx', 3)).toBe(4);
    expect(columnOf('\t\tx', 2, 2)).toBe(4);
    expect(columnOf('abc', 2)).toBe(2);
  });
});

describe('emphasisOf', () => {
  it('turns a paired change into column ranges on both lines', () => {
    const [hunk] = hunksOf('@@ -1,2 +1,2 @@\n context\n-\tlet x = 1;\n+\tlet x = 2;');
    const ranges = emphasisOf(hunk!.lines);
    expect(ranges.get(1)).toEqual([[12, 13]]);
    expect(ranges.get(2)).toEqual([[12, 13]]);
    expect(ranges.has(0)).toBe(false);
  });
});
