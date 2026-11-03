import { existsSync, readdirSync, statSync } from 'node:fs';
import { join } from 'node:path';
import type * as BenchModule from '../../../bin/bench.ts';
import type * as DriveModule from '../../../bench/drive.ts';
import type { BenchData } from './data.ts';

const findBenchOutDirs = (dir: string, depth = 3): string[] => [
  ...(existsSync(join(dir, 'log.jsonl')) ? [dir] : []),
  ...(depth && existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && !/^(\.|engine$)/.test(e.name) && !existsSync(join(dir, e.name, 'human')))
        .flatMap(e => findBenchOutDirs(join(dir, e.name), depth - 1))
    : []),
];

const findDrivenBenchDirs = (dir: string): string[] => [
  ...(existsSync(join(dir, 'set.json')) ? [dir] : []),
  ...(existsSync(dir)
    ? readdirSync(dir, { withFileTypes: true })
        .filter(e => e.isDirectory() && existsSync(join(dir, e.name, 'set.json')))
        .map(e => join(dir, e.name))
    : []),
];

const runIds = (data: string) =>
  existsSync(data) ? readdirSync(data).filter(id => existsSync(join(data, id, 'run.json'))) : [];

let cached: { key: string; rows: Promise<BenchData['rows']> } | undefined;

export const readBench = async (dirs: string[]): Promise<BenchData> => {
  const outs = dirs.flatMap(dir => findBenchOutDirs(dir));
  const drives = [...new Set(dirs.flatMap(findDrivenBenchDirs))];
  const key = JSON.stringify(
    [...outs, ...drives].map(dir =>
      ['log.jsonl', 'events.jsonl', 'done'].map(f => statSync(join(dir, f), { throwIfNoEntry: false })?.mtimeMs)
    )
  );
  if (cached?.key !== key) {
    const rows = import(new URL('../../../bin/bench.ts', import.meta.url).href).then(
      ({ readBenchRows }: typeof BenchModule) =>
        outs.flatMap(out =>
          readBenchRows(out).map(row => {
            const data = join(out, row.case, row.labels.arm ?? '', 'data');
            const runs = runIds(data);
            return runs.length ? { ...row, data, runs } : row;
          })
        )
    );
    cached = { key, rows };
    rows.catch(() => {
      if (cached?.rows === rows) cached = undefined;
    });
  }
  const { readBenchDriveState }: typeof DriveModule = await import(
    new URL('../../../bench/drive.ts', import.meta.url).href
  );
  return { rows: await cached.rows, drives: drives.map(readBenchDriveState) };
};
