import { describe, expect, it } from 'vitest';
import { addedLines, fanOut, fileDiffs, hunks, itemsOf, positionless, scriptItems } from '../src/over.ts';

const diff = [
  'diff --git a/src/a.ts b/src/a.ts',
  'index 1111111..2222222 100644',
  '--- a/src/a.ts',
  '+++ b/src/a.ts',
  '@@ -1,2 +1,2 @@',
  ' const keep = 0;',
  '-const old = 1;',
  '+export const a = 1;',
  '@@ -10,1 +10,2 @@ function tail() {',
  '   return 1;',
  '+  // tail',
  'diff --git a/docs/b.md b/docs/b.md',
  'new file mode 100644',
  '--- /dev/null',
  '+++ b/docs/b.md',
  '@@ -0,0 +1,2 @@',
  '+# Title',
  '+Text',
  '',
].join('\n');

describe('over', () => {
  it('splits a diff per file, each part with its header', () => {
    const files = fileDiffs(diff);
    expect(files.map(f => f.label)).toEqual(['src/a.ts', 'docs/b.md']);
    expect(files[0]!.text).toMatch(/^diff --git a\/src\/a.ts/);
    expect(files[0]!.text).toContain('+  // tail');
    expect(files[0]!.text).not.toContain('docs/b.md');
    expect(files[1]!.text).toMatch(/\+Text$/);
  });

  it('splits a diff per hunk, each hunk with its file header', () => {
    const parts = hunks(diff);
    expect(parts.map(h => h.label)).toEqual([
      'src/a.ts @@ -1,2 +1,2 @@',
      'src/a.ts @@ -10,1 +10,2 @@',
      'docs/b.md @@ -0,0 +1,2 @@',
    ]);
    expect(parts[1]!.text).toMatch(/^diff --git a\/src\/a.ts[\s\S]*\+\+\+ b\/src\/a.ts\n@@ -10,1/);
    expect(parts[1]!.text).not.toContain('export const a');
    expect(parts[2]!.text).toContain('new file mode');
  });

  it('keeps added lines under their file names', () => {
    expect(addedLines(diff)).toBe('src/a.ts\nexport const a = 1;\n  // tail\n\ndocs/b.md\n# Title\nText');
  });

  it('reads script output as JSON lines or plain lines', () => {
    const output = [
      '{"file":"docs/x.mdx","line":4,"claim":"returns a bigint"}',
      '',
      'a plain line',
      '{"path":"kit/y.ts"}',
      '{"other":1}',
      '[1,2]',
    ].join('\n');
    expect(scriptItems(output)).toEqual([
      { label: 'docs/x.mdx:4', text: '{"file":"docs/x.mdx","line":4,"claim":"returns a bigint"}' },
      { label: 'item 2', text: 'a plain line' },
      { label: 'kit/y.ts', text: '{"path":"kit/y.ts"}' },
      { label: 'item 4', text: '{"other":1}' },
      { label: 'item 5', text: '[1,2]' },
    ]);
  });

  it('gives each value of over its items', () => {
    const inputs = { diff, event: '/bothub go', output: 'one\ntwo\n' };
    expect(itemsOf('diff', inputs)).toEqual([{ label: 'diff', text: diff }]);
    expect(itemsOf('added', inputs)[0]!.text).toBe(addedLines(diff));
    expect(itemsOf('event', inputs)).toEqual([{ label: 'event', text: '/bothub go' }]);
    expect(itemsOf('each-file', inputs)).toHaveLength(2);
    expect(itemsOf('each-hunk', inputs)).toHaveLength(3);
    expect(itemsOf({ run: 'x' }, inputs)).toEqual([{ label: 'output', text: 'one\ntwo' }]);
    expect(itemsOf({ each: 'x' }, inputs).map(i => i.text)).toEqual(['one', 'two']);
  });

  it('has no items when there is nothing to look at', () => {
    const empty = { diff: '' };
    for (const over of ['diff', 'added', 'event', 'each-file', 'each-hunk'] as const)
      expect(itemsOf(over, empty)).toEqual([]);
    expect(itemsOf({ run: 'x' }, { diff, output: ' \n' })).toEqual([]);
  });

  it('names what a fan-out runs once for', () => {
    expect(fanOut('each-file')).toBe('file');
    expect(fanOut('each-hunk')).toBe('hunk');
    expect(fanOut({ each: 'x' })).toBe('item');
    expect(fanOut({ run: 'x' })).toBeUndefined();
    expect(fanOut('diff')).toBeUndefined();
    expect(fanOut(undefined)).toBeUndefined();
  });
});

const SHIFTED = [
  ['hunk headers', '@@ -1,2 +1,2 @@ f\n+a', '@@ -40,2 +41 @@ f\n+a'],
  ['a script line field', '{"file":"a.ts","line":3,"hunk":"+a"}', '{"file":"a.ts","line":30,"hunk":"+a"}'],
  ['blob ids', 'index 1111111..2222222 100644\n+a', 'index 3333333..4444444 100644\n+a'],
] as const;

const CHANGED = [
  ['an added line', '@@ -1 +1 @@\n+a', '@@ -1 +1 @@\n+b'],
  ['the file', '{"file":"a.ts","line":3}', '{"file":"b.ts","line":3}'],
] as const;

describe('positionless', () => {
  it.each(SHIFTED)('reads the same item on another base: %s', (_, before, after) => {
    expect(positionless(before)).toBe(positionless(after));
  });

  it.each(CHANGED)('tells a changed item apart: %s', (_, before, after) => {
    expect(positionless(before)).not.toBe(positionless(after));
  });
});
