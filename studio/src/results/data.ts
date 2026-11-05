import { Schema } from 'effect';
import { ResultSheet } from '../../../src/results.ts';

export const ResultsData = Schema.Union([
  Schema.Struct({ kind: Schema.Literal('ready'), sheet: ResultSheet }),
  Schema.Struct({ kind: Schema.Literal('failed'), why: Schema.String }),
]);
