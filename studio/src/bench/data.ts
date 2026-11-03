import { Schema } from 'effect';
import type { DriveState } from '../../../bench/drive.ts';
import type { readBenchRows } from '../../../bin/bench.ts';

const isObject = (u: unknown) => typeof u === 'object' && u !== null;

export type BenchRow = ReturnType<typeof readBenchRows>[number] & { data?: string; runs?: string[] };

export const BenchData = Schema.Struct({
  rows: Schema.mutable(Schema.Array(Schema.declare((u): u is BenchRow => isObject(u)))),
  drives: Schema.Array(Schema.declare((u): u is DriveState => isObject(u))),
});
export type BenchData = typeof BenchData.Type;
