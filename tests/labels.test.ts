import { mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { Effect } from 'effect';
import { describe, expect, it, vi } from 'vitest';
import { readRunLabels, writeRunLabels } from '../src/labels.ts';
import { tmp } from './kit.ts';

const cut = '{"key":"arm","value":"v2"}\n{"key":"note","value":';

const seed = (text: string) => {
  const data = tmp('labels');
  mkdirSync(join(data, 'run-1'));
  writeFileSync(join(data, 'run-1', 'labels.jsonl'), text);
  return data;
};

describe('run labels log', () => {
  it('reads past an incomplete last line and counts it skipped', () => {
    const data = seed(cut);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      expect(readRunLabels(data, 'run-1')).toEqual({ arm: 'v2' });
      expect(error.mock.calls.map(c => String(c[0]))).toEqual([
        expect.stringContaining('1 skipped incomplete JSONL row at line 2'),
      ]);
    } finally {
      error.mockRestore();
    }
  });

  it('moves an incomplete last line aside before it appends, keeping its bytes', async () => {
    const data = seed(cut);
    const error = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      const labels = await Effect.runPromise(writeRunLabels(data, 'run-1', { note: 'flaky' }));
      const partial = readdirSync(join(data, 'run-1')).filter(name => name.endsWith('.partial'));
      expect([
        labels,
        readFileSync(join(data, 'run-1', 'labels.jsonl'), 'utf8').split('\n').length,
        partial.map(name => readFileSync(join(data, 'run-1', name), 'utf8')),
      ]).toEqual([{ arm: 'v2', note: 'flaky' }, 3, ['{"key":"note","value":']]);
    } finally {
      error.mockRestore();
    }
  });

  it('fails on a malformed line before the last', () => {
    const data = seed('{"key":"arm",\n{"key":"note","value":"x"}\n');
    expect(() => readRunLabels(data, 'run-1')).toThrow(SyntaxError);
  });
});
