import { Schema } from 'effect';

const commit = Schema.String.check(Schema.isPattern(/^[a-f0-9]{40,64}$/));

export const TuneStep = Schema.Struct({
  id: Schema.String,
  iteration: Schema.Number,
  parent: Schema.Union([Schema.Literal(''), commit]),
  proposer: Schema.Literals(['retro', 'history', 'manual', 'skill', 'structure']),
  graph: commit,
  rationale: Schema.String,
  diff: Schema.String,
  evals: Schema.mutable(
    Schema.Array(
      Schema.Struct({
        candidate: Schema.String,
        split: Schema.Literals(['mine', 'fit', 'validate', 'test']),
        cases: Schema.mutable(Schema.Array(Schema.String)),
        quality: Schema.Finite,
        ci: Schema.mutable(Schema.Tuple([Schema.Finite, Schema.Finite])),
        delta: Schema.optionalKey(Schema.Finite),
        pUp: Schema.optionalKey(Schema.Finite),
        flips: Schema.optionalKey(Schema.Record(Schema.String, Schema.Literals(['up', 'down', 'win', 'loss']))),
        usd: Schema.Finite,
        minutes: Schema.Finite,
        perRun: Schema.optionalKey(Schema.Struct({ usd: Schema.Finite, minutes: Schema.Finite })),
        saved: Schema.optionalKey(
          Schema.Record(
            Schema.Literals(['usd', 'minutes']),
            Schema.Struct({ share: Schema.Finite, pDown: Schema.Finite })
          )
        ),
        codex: Schema.Finite,
        claude5h: Schema.Finite,
      })
    )
  ),
  verdict: Schema.Literals(['kept', 'discarded', 'screened-out', 'infra']),
  why: Schema.String,
  at: Schema.String,
});
