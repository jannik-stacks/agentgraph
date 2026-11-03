import { Schema } from 'effect';
import { ResultSheet } from '../../../src/results.ts';
import { TuneStep } from '../../../tune/result.ts';
import { resultSources } from './result.ts';

export const ResultsData = Schema.Record(
  Schema.Literals(resultSources),
  Schema.Union([
    Schema.Struct({
      kind: Schema.Literal('ready'),
      sheet: ResultSheet,
      candidates: Schema.Record(Schema.String, TuneStep),
    }),
    Schema.Struct({ kind: Schema.Literal('failed'), why: Schema.String }),
  ])
);
