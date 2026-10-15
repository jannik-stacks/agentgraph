# Pipeline and checks

From an event to finished jobs, and when a job counts as done.

`plan` matches an event against every workflow's triggers.
`runPlan` runs the planned jobs in dependency order, each in a fresh worktree.

The fields are on `PlannedJob` in [src/dispatch.ts](../../src/dispatch.ts).

## The until loop

A bot job runs, then each check in its `until` runs against the worktree. While a `block` check
fails, its findings and those of failing `warn` checks go back to the same bot as a follow-up
prompt, until no `block` check fails, `until.max` follow-ups are used or the bot's `usd-per-run` is
spent. The loop is in

`attempts`. Every check ends in a verdict.

The fields are on `Verdict` in [src/store.ts](../../src/store.ts).

A check gates when its mode is not `log`. A skipped check does not gate, unless no gating check
ran at all. Only failing `block` checks hold the change or fail the run; `warn` ones are recorded
and let it through. A `blocked` verdict means the check could not run, and the job asks a
human instead of sending the bot after it.

Two jobs never work on one branch at the same time. A job whose branch another live run holds
waits for it, up to its own timeout, and is deferred only after that.

See `failingChecks` in [src/pipeline/checks.ts](../../src/pipeline/checks.ts).

## Verdicts

A check is a script (exit code), a bot that replies `PASS` or `FAIL`, or a `decide` check that asks
its body as a yes or no question to a small local model (`decideCheck`). A bot that
does not answer clearly fails; a `decide` check that gets no answer from its model is blocked. A
check that fans out over files, hunks or script items passes only when every item passes, and its findings are labelled by item.

See `verdictOf` in [src/pipeline/checks.ts](../../src/pipeline/checks.ts).

When a job's final run ends, `summarizeOutcome` adds how it ended to the run's
summaries: one line with its status, what it proposed, what was rejected and what landed, and one
line per failed check with the gist of its findings.
