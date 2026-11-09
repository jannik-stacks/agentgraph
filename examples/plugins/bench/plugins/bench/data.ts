import { Schema } from 'effect';
import type { BenchRow } from '../../../../../bench/runs.ts';
import { ResultSheet } from '../../../../../src/results.ts';

export type { BenchRow };

export const BenchData = Schema.Struct({
  rows: Schema.mutable(Schema.Array(Schema.declare((u): u is BenchRow => typeof u === 'object' && u !== null))),
  fields: ResultSheet.fields.fields,
  conflicts: Schema.mutable(Schema.Array(Schema.String)),
});
export type BenchData = typeof BenchData.Type;
