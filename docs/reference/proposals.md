# Proposals

How a bot's final message becomes writes on GitHub or in local issues.

A bot ends its reply with a fenced `bothub` block, read by `extractProposals`. The
concepts are on [Proposals](../proposals.md).

See `Proposal` in [src/outputs.ts](../../src/outputs.ts).

## Validation

`validate` accepts only what the job explicitly allows and rejects the rest with a reason. Pushed files are
checked with `checkPaths`.

The fields are on `Validated` in [src/outputs.ts](../../src/outputs.ts).

## Applying

`apply` pushes first, then applies the rest in order. Each effect has a stable key and is journalled as
`pending` before anything happens, so a retry after a crash finds what an earlier run already did.

The fields are on `ApplyResult` in [src/apply.ts](../../src/apply.ts).
