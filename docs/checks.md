# Checks and results

A check looks at a try, or at an ended run, and records a result. After a session, the step's checks run in parallel and their findings come back together as feedback. <!-- code: src/engine.ts#runStepChecks -->

A check has a `run` script, an `agent` judge, or both; [the graph folder](reference.md#checks) lists the fields.

| Mode | On failure |
| --- | --- |
| `info` | Never fails; the result is only recorded |
| `warn` | Record it and go on |
| `block` | Fail the try; the findings are feedback for the next one |
| `stop` | Stop the run |

## Results

A result is a JSON object of the shape the check's `returns` describes. Without `returns` it is `{pass, why}`: `pass` is a boolean and `why` holds the findings.

A result passes when it matches `returns` and `pass`, and its script exited 0. `pass` is written like `returns` and defaults to `{ properties: { pass: { const: true } } }`, so a threshold is a `minimum` or `maximum`. `why` never decides, and an `info` check takes no `pass`.

```yaml
mode: block
returns: { type: object, required: [calls], properties: { calls: { type: integer } } }
pass: { properties: { calls: { maximum: 40 } } }
run: jq -cs '{calls: map(select(.event.type == "tool")) | length}' "$AGENTGRAPH_RUN_TRACE"
```

Without `returns`, a script's exit 0 passes and its output is the findings. With `returns`, its last printed line is the result.

A check with its own `returns` keeps the result as its `value`, such as `{calls: 12}`; one with `each` keeps the `share` of items that passed. A result that does not match `returns`, or an unanswered item, makes the check `empty`, which readers skip, never count as 0. <!-- code: src/engine.ts#runOneCheck -->

## Judges

A judge reads the diff, the item or the script's output, and calls the `result` tool, whose input is `returns`; a call that does not match is refused with the reason. A judge that stops without a result is asked once more, and one that crashes is retried once. If none comes, a `block` or `stop` check parks the run as a runner error, and an `info` or `warn` check records it. <!-- code: src/engine.ts#askJudge src/result.ts#makeResultServer -->

With `each`, a judge answers every item on its own, and any failed item fails the check. No items passes; more than `max` fail as one finding; a failing slicer command fails with its output.

Judges start fresh. Within a run, a passed item is reused while the diff and prompt stay the same; failed items, changed checks, new answers and restarts judge again. Judges that read traces or have their own `returns` are never reused. <!-- code: src/engine.ts#passes src/graph.ts#makeWorkflowGraph -->

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

A workflow's `checks` run once when its run ends, done or stopped, on a throwaway checkout of the kept files, measured from `startCommit`, with an empty reply. They must be `info` or `warn` and never change the run's status. A runner killed partway runs only the ones it still owes. Every result goes to the run's [check record](runs.md#the-check-record), never the trace, so run cost and checking cost stay apart. A check that cannot run there gives an empty result. <!-- code: src/workflow.ts#transition src/engine.ts#runEndChecks -->

`agi check <name>... --runs` does the same on ended runs, `info` checks as `info` and the rest as `warn`; `--workflow` and `--issue` narrow the runs. A check with a later result under its current version is skipped. The studio marks these results "checked later".

A `reads: traces` check gets an empty folder beside the run's traces, so it works on runs whose kept files are gone.

## The Results tab

The studio's Results tab, at `/results`, shows what checks gave on the data folder's runs, the bench's arms or every tune's candidates, depending on how the [studio](local.md#the-studio) started. Each run counts with each check's latest result. <!-- code: bin/results.ts#readRunResults studio/src/results/ResultsPage.tsx#ResultsPage -->

The table has one row per result field: runs that gave it, failed results, values outside `pass`, the median, one dot per run, and a trend. `by` splits a field by workflow, model, tune or another dimension, and a field's `unit` sets how it reads. Runs that ended before any step passed or session started are dead and hidden by default. The chart draws a field against time, order, a dimension or another field, one dot per run.

A run's page shows the gates that failed, with the fields past their limit, then every field's value, marked "at run end" or "checked later".

## Reading traces

`reads: traces` gives an agent a read-only `traces.md` with the issue's other runs, oldest first, retros left out: prompts, thinking, tool calls and results, replies, checks, proposals and outcomes, with trace line numbers to cite. Long text is cut in the middle, secrets are redacted, and past about 60,000 characters the oldest runs keep only endings and outcomes. <!-- code: src/context.ts#transcript -->

Scripts get the same file as `AGENTGRAPH_TRACES`, so a script can check, for example, that tests ran after the last edit. <!-- code: src/engine.ts#traced -->

A judge that reads traces checks how the work was done:

```yaml
# checks/claims.md
mode: warn
agent: auditor
---
Did the implementor do what its reply says it did?
```

The studio marks checks and steps that read traces. <!-- code: src/graph.ts#makeWorkflowGraph -->
