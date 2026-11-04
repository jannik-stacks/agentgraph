import { Schema } from 'effect';
import type { BenchRow } from '../../../bench/runs.ts';

export type { BenchRow };

export const BenchData = Schema.Struct({
  rows: Schema.mutable(Schema.Array(Schema.declare((u): u is BenchRow => typeof u === 'object' && u !== null))),
});
export type BenchData = typeof BenchData.Type;
