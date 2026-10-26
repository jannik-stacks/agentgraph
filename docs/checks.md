# Checks and results

A check looks at a try, or at a run after it ended, and records a result. After a session, all the step's checks run in parallel, and all findings come back together as feedback. <!-- code: src/engine.ts#runStepChecks -->

A check has a `run` script, an `agent` judge, or both. [The graph folder](reference.md#checks) lists the fields.

| Mode | On failure |
| --- | --- |
| `info` | Never fails; the result is only recorded |
| `warn` | Record it and go on |
| `block` | Fail the try; the findings are feedback for the next one |
| `stop` | Stop the run |

## Results

A result is a JSON object of the shape the check's `returns` describes. Without `returns` it is `{pass, why}`: `pass` is a boolean and `why` holds the findings.

A result passes when it matches `returns`, matches the check's `pass`, and its script, if any, exited 0. `pass` is written like `returns` and defaults to `{ properties: { pass: { const: true } } }`, so a threshold is a `minimum` or `maximum` on a field. `why` never decides. An `info` check takes no `pass`.

```yaml
mode: block
returns: { type: object, required: [calls], properties: { calls: { type: integer } } }
pass: { properties: { calls: { maximum: 40 } } }
run: jq -cs '{calls: map(select(.event.type == "tool")) | length}' "$AGENTGRAPH_RUN_TRACE"
```

A script without its own `returns` is plain Unix: exit 0 passes and its output is the findings. With `returns`, the last line it prints is the result.

A check with its own `returns` keeps the result as its `value`, such as `{calls: 12}` or `{usd: 0.4}`. A check with `each` keeps the `share` of items that passed. A result that does not match `returns`, or an item a judge never answered, makes the check `empty`, with the reason in its findings. An `empty` result is skipped, never counted as 0. <!-- code: src/engine.ts#runOneCheck -->

## Judges

A judge reads the diff, the item or the script's output, and records its result by calling the `result` tool, whose input is `returns`. A call that does not match is refused with the reason, and the judge calls again. A judge that stops without a result is resumed once and asked for it. One that crashes or times out is tried once more. If it still gives none, a `block` or `stop` check parks the run as a runner error, and an `info` or `warn` check records it. <!-- code: src/engine.ts#askJudge src/result.ts#makeResultServer -->

With `each`, a judge answers every item on its own, and any failed item fails the check. No items passes with "Judged nothing". More than `max` items fail as one finding. A failing slicer command fails once with its output.

Judges always start fresh. Within a run, a passed item is reused while the diff and the judge prompt stay the same. Failed items, changed checks, new human answers and a runner restart judge again. Judges that read traces or have their own `returns` are never reused. <!-- code: src/engine.ts#passes src/graph.ts#makeWorkflowGraph -->

## Script variables

Scripts run in the checkout, without network, with these variables: <!-- code: src/engine.ts#runOneCheck -->

| Variable | Contents | Given to |
| --- | --- | --- |
| `AGENTGRAPH_BASE` | The change's starting commit, or the branch fork point | Everything, sessions too |
| `AGENTGRAPH_DIR` | The graph folder, read only | Everything |
| `AGENTGRAPH_ISSUE` | Issue number | Checks |
| `AGENTGRAPH_PROPOSALS` | JSON file of pending proposals | Checks |
| `AGENTGRAPH_CONTEXT` | Issue, pull request and human answers | Checks |
| `AGENTGRAPH_REPLY` | The try's reply | Checks |
| `AGENTGRAPH_TRACES` | The issue's run traces, as in [Reading traces](#reading-traces) | Checks |
| `AGENTGRAPH_RUN_TRACE` | This run's raw trace, one JSON event per line | Checks |
| `AGENTGRAPH_ITEM` | The `each` item | Checks |

"Everything" means checks, `run` steps, slicer commands and setup.

## End checks

A workflow's `checks` run once when its run ends, done or stopped. They run on a throwaway checkout of the run's kept files, with the change measured from the run's `startCommit` and an empty reply. They must be `info` or `warn` and never change the run's status. A runner killed partway runs only the checks it still owes. Every result, from a step, a run's end or later, goes to the run's [check record](runs.md#the-check-record). Judging adds no sessions to the run's trace, so a run's cost and its checking cost stay apart. A check that cannot run there gives an empty result. <!-- code: src/workflow.ts#transition src/engine.ts#runEndChecks -->

`agi check <name>... --runs` runs checks the same way on runs that already ended, `info` checks as `info` and the rest as `warn`. `--workflow` and `--issue` narrow the runs. A check that already has a later result under its current version is skipped, so a rerun does nothing until the check changes. The studio marks these results "checked later".

A check with `reads: traces` needs only the run's traces. It gets an empty folder beside the run's traces, without setup, so it works on runs whose kept files are gone.

## The Results tab

The studio's Results tab, at `/results`, shows what checks gave. It reads the data folder's runs, the bench's arms, or every tune's candidates, depending on how the [studio](local.md#the-studio) started. Each run counts with each check's latest result. <!-- code: bin/results.ts#readRunResults studio/src/results/ResultsPage.tsx#ResultsPage -->

The table has one row per result field: how many runs gave it, how many results failed and how many values fall outside `pass`, the median, one dot per run, and a trend by day, by tens of runs or by tune iteration. `by` splits a field by workflow, model, tune or another dimension. A number field's `unit` (`usd`, `minutes`, `seconds`, `tokens` or `share`) sets how it reads. Runs that ended before any step passed or any session started are dead, counted apart and hidden by default. The chart draws a field against time, order, a dimension or another field, with a dot per run that links to it.

A run's page shows the gates that failed, with the fields past their limit, then every field's value, marked "at run end" or "checked later".

## Reading traces

`reads: traces` gives an agent a read-only `traces.md` beside its news file. It holds the issue's other runs, oldest first, retros left out: system prompts once per agent, prompts, thinking, tool calls and results, replies, checks, proposals and outcomes. Entries keep their trace line numbers so the agent can cite them. Long text is cut in the middle, secrets are redacted, and past about 60,000 characters the oldest runs keep only session endings and outcomes. <!-- code: src/context.ts#transcript -->

Scripts get the same file as `AGENTGRAPH_TRACES`, so a script can check, for example, that tests ran after the last edit. <!-- code: src/engine.ts#traced -->

A judge that reads traces checks how the work was done. This one compares what the implementor says it did with its tool calls:

```yaml
# checks/claims.md
mode: warn
agent: auditor
---
Did the implementor do what its reply says it did?
```

The studio marks checks and steps that read traces. <!-- code: src/graph.ts#makeWorkflowGraph -->
