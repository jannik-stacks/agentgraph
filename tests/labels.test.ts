import { spawn } from 'node:child_process';
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

  it('keeps every edit when processes recover the same cut line at once', async () => {
    const labels = join(import.meta.dirname, '..', 'src', 'labels.ts');
    const writers = ['a', 'b', 'c', 'd'];
    const edit = (data: string, key: string) =>
      new Promise<number | null>(done =>
        spawn(
          process.execPath,
          [
            '--input-type=module',
            '-e',
            `import { existsSync } from 'node:fs';
             import { Effect } from 'effect';
             import { writeRunLabels } from ${JSON.stringify(labels)};
             while (!existsSync(${JSON.stringify(join(data, 'go'))})) await new Promise(r => setTimeout(r, 5));
             await Effect.runPromise(writeRunLabels(${JSON.stringify(data)}, 'run-1', { ${key}: 'x' }));`,
          ],
          { cwd: join(import.meta.dirname, '..'), env: { ...process.env, NODE_OPTIONS: '' }, stdio: 'ignore' }
        ).on('exit', done)
      );
    const rounds = await Promise.all(
      Array.from({ length: 3 }, async () => {
        const data = seed(cut);
        const exits = writers.map(key => edit(data, key));
        await new Promise(r => setTimeout(r, 1500));
        writeFileSync(join(data, 'go'), '');
        return [
          await Promise.all(exits),
          readRunLabels(data, 'run-1'),
          readdirSync(join(data, 'run-1')).filter(name => name.endsWith('.partial')).length,
        ];
      })
    );
    const all = { arm: 'v2', ...Object.fromEntries(writers.map(key => [key, 'x'])) };
    expect(rounds).toEqual(Array.from({ length: 3 }, () => [[0, 0, 0, 0], all, 1]));
  }, 60_000);

  it('fails on a malformed line before the last', () => {
    const data = seed('{"key":"arm",\n{"key":"note","value":"x"}\n');
    expect(() => readRunLabels(data, 'run-1')).toThrow(SyntaxError);
  });
});
