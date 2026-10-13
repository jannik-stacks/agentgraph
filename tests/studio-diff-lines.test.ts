import { describe, expect, it } from 'vitest';
import {
  changedSpans,
  columnOf,
  emphasisOf,
  hunksOf,
  type Kind,
  pairLines,
} from '../studio/src/dashboard/diff-lines.ts';

const kinds = (...list: Kind[]) => list.map(kind => ({ kind, text: 'x' }));
const lines = (...list: [Kind, string][]) => list.map(([kind, text]) => ({ kind, text }));

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

  it('pairs the lines of an uneven run with their most similar counterparts, in order', () => {
    const pairs = pairLines(
      lines(
        ['del', '  tools: z.array(z.string()),'],
        ['del', '  cron: z.string(),'],
        ['add', '  {'],
        ['add', '    tools: z.array(z.string()),'],
        ['add', '    cron: z.string(),'],
        ['add', '  }']
      )
    );
    expect(pairs.get(0)).toBe(3);
    expect(pairs.get(1)).toBe(4);
    expect(pairs.has(2)).toBe(false);
    expect(pairs.has(5)).toBe(false);
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

  it('pairs nothing in an uneven run of rewritten lines', () => {
    expect(pairLines(lines(['del', 'return value;'], ['add', 'throw new Error();'], ['add', '}'])).size).toBe(0);
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
  it('marks the changed word', () => {
    expect(changedSpans('const a = 1;', 'const a = 42;')).toEqual({ del: [[10, 11]], add: [[10, 12]] });
  });

  it('marks only the inserted side of a pure insertion', () => {
    expect(changedSpans('foo(a)', 'foo(a, b)')).toEqual({ del: [], add: [[5, 8]] });
  });

  it('marks each of several separate edits in a line on its own', () => {
    expect(changedSpans('call(alpha, 1, beta)', 'call(gamma, 1, delta)')).toEqual({
      del: [
        [5, 10],
        [15, 19],
      ],
      add: [
        [5, 10],
        [15, 20],
      ],
    });
  });

  it('marks a punctuation-only edit', () => {
    expect(changedSpans('foo(a, b);', 'foo(a; b);')).toEqual({ del: [[5, 6]], add: [[5, 6]] });
    expect(changedSpans('x = a.b', 'x = a?.b')).toEqual({ del: [], add: [[5, 6]] });
  });

  it('marks a renamed identifier as a whole word', () => {
    expect(changedSpans('const total = count + 1;', 'const sum = count + 1;')).toEqual({
      del: [[6, 11]],
      add: [[6, 9]],
    });
  });

  it('joins changes that only one whitespace token separates', () => {
    expect(changedSpans('say red fox now', 'say blue cat now')).toEqual({ del: [[4, 11]], add: [[4, 12]] });
  });

  it('marks nothing on identical lines', () => {
    expect(changedSpans('same', 'same')).toEqual({ del: [], add: [] });
  });

  it('gives up on a full rewrite', () => {
    expect(changedSpans('return value;', 'throw new Error();')).toBeUndefined();
    expect(changedSpans('abcdefghij', 'abcdXXXXXX')).toBeUndefined();
    expect(changedSpans('  const total = items.length;', '  throw new Error("empty");')).toBeUndefined();
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
