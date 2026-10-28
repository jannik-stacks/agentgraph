import { Schema } from 'effect';

const optional = <S extends Schema.Schema.Any>(schema: S) => Schema.optionalWith(schema, { exact: true });
const commit = Schema.String.pipe(Schema.pattern(/^[a-f0-9]{40,64}$/));

export const TuneStep = Schema.Struct({
  id: Schema.String,
  iteration: Schema.Number,
  parent: Schema.Union(Schema.Literal(''), commit),
  proposer: Schema.Literal('retro', 'history', 'manual', 'skill', 'structure'),
  graph: commit,
  rationale: Schema.String,
  diff: Schema.String,
  evals: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        candidate: Schema.String,
        split: Schema.Literal('mine', 'fit', 'validate', 'test'),
        cases: Schema.mutable(Schema.Array(Schema.String)),
        quality: Schema.JsonNumber,
        ci: Schema.mutable(Schema.Tuple(Schema.JsonNumber, Schema.JsonNumber)),
        delta: optional(Schema.JsonNumber),
        pUp: optional(Schema.JsonNumber),
        flips: optional(Schema.Record({ key: Schema.String, value: Schema.Literal('up', 'down', 'win', 'loss') })),
        usd: Schema.JsonNumber,
        minutes: Schema.JsonNumber,
        perRun: optional(Schema.Struct({ usd: Schema.JsonNumber, minutes: Schema.JsonNumber })),
        saved: optional(
          Schema.Record({
            key: Schema.Literal('usd', 'minutes'),
            value: Schema.Struct({ share: Schema.JsonNumber, pDown: Schema.JsonNumber }),
          })
        ),
        codex: Schema.JsonNumber,
        claude5h: Schema.JsonNumber,
      })
    )
  ),
  verdict: Schema.Literal('kept', 'discarded', 'screened-out', 'infra'),
  why: Schema.String,
  at: Schema.String,
});
