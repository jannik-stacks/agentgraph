# Checks and results

A check looks at a try, or at an ended run, and records a result. After a session, the step's checks run in parallel and their findings come back together as feedback. <!-- code: src/run/check.ts#runStepChecks -->

A check has a `run` script, an `agent` judge, or both; [the graph folder](reference.md#checks) lists the fields. <!-- code: src/types.ts#Check src/result.ts#CheckMode -->

| Mode    | On failure                                               |
| ------- | -------------------------------------------------------- |
| `info`  | Never fails; the result is only recorded                 |
| `warn`  | Record it and go on                                      |
| `block` | Fail the try; the findings are feedback for the next one |
| `stop`  | Stop the run                                             |

The engine has no size cap on a change. To keep pull requests small, use a check like [the agentgraph example's size check](../examples/agentgraph/checks/size.md), whose script counts the lines and files a change touches. <!-- code: examples/agentgraph/scripts/size.mjs -->

## Results

A result is a JSON object of the shape the check's `returns` describes. Without `returns` it is `{pass, why}`: `pass` is a boolean and `why` holds the findings. <!-- code: src/result.ts#defaultReturns -->

A result passes when it matches `returns` and `pass`, and its script exited 0. `pass` is written like `returns` and defaults to `{ properties: { pass: { const: true } } }`, so a threshold is a `minimum` or `maximum`. `why` never decides, and an `info` check takes no `pass`. <!-- code: src/result.ts#defaultPass src/result.ts#findMismatch src/result.ts#whyPassUndecided -->

```yaml
mode: block
returns: { type: object, required: [calls], properties: { calls: { type: integer } } }
pass: { properties: { calls: { maximum: 40 } } }
run: jq -cs '{calls: map(select(.event.type == "tool")) | length}' "$AGENTGRAPH_RUN_TRACE"
```

Without `returns`, a script's exit 0 passes and its output is the findings. With `returns`, its last printed line is the result. <!-- code: src/result.ts#readScriptResult -->

A check with its own `returns` keeps the result as its `value`, such as `{calls: 12}`; one with `each` keeps the `share` of items that passed, except in `info` mode. <!-- code: src/run/check.ts#runOneCheck src/types.ts#CheckResult -->

Unreadable or mismatched results fail except in `info` mode. They are marked `empty` and excluded from averages; this does not turn failure into a pass. An `each` check with no items passes with an empty result and a reason. <!-- code: src/run/check.ts#runOneCheck src/run/check.ts#runStepChecks src/types.ts#CheckResult -->

## Judges

A judge reads the diff, item or script output and calls the schema-validated `result` tool. The engine asks again for a missing result and retries a crashed judge once. Without a result, `block` and `stop` checks park the run; `info` and `warn` checks record the failure. <!-- code: src/run/execute.ts#runJudge src/result.ts#makeResultServer src/result.ts#resultTool src/result.ts#getRecordedResult -->

`each` judges items separately; any failed item fails the check. No items passes; more than `max` or a failing slicer command fails with findings.

Judges start fresh. Passed items may be reused within a run while the diff and prompt match; changed checks, answers and restarts invalidate reuse. Trace readers and custom result schemas are never reused. <!-- code: src/run/check.ts#passes src/graph.ts#makeWorkflowGraph -->

## Script variables

Scripts run in the checkout, without network, with these variables: <!-- code: src/run/check.ts#runOneCheck src/run/check.ts#makeScriptEnv src/run/check.ts#getCheckFiles src/run/check.ts#getTraceFiles -->

| Variable               | Contents                                                                         | Given to                                     |
| ---------------------- | -------------------------------------------------------------------------------- | -------------------------------------------- |
| `AGENTGRAPH_BASE`      | The change's starting commit, or the branch fork point                           | Everything, sessions too                     |
| `AGENTGRAPH_DIR`       | The graph folder, read only                                                      | Everything                                   |
| `AGENTGRAPH_ISSUE`     | Issue number                                                                     | Checks and `run` steps                       |
| `AGENTGRAPH_PROPOSALS` | JSON file of pending proposals                                                   | Checks                                       |
| `AGENTGRAPH_CONTEXT`   | Issue, pull request and human answers                                            | Checks                                       |
| `AGENTGRAPH_REPLY`     | The try's reply                                                                  | Checks                                       |
| `AGENTGRAPH_TRACES`    | The issue's run traces, as in [Reading traces](#reading-traces)                  | Checks, and `run` steps with `reads: traces` |
| `AGENTGRAPH_RUN_TRACE` | This run's raw trace, one JSON event per line                                    | Checks, and `run` steps with `reads: traces` |
| `AGENTGRAPH_ITEM`      | The `each` item                                                                  | Checks                                       |
| `AGENTGRAPH_FROM`      | The old base, after a [base move](workflows.md#when-the-base-or-the-graph-moves) | Checks                                       |

"Everything" means checks, `run` steps, slicer commands and setup.

## End checks

Workflow `checks` run when the run ends on a throwaway checkout of its kept change, with no tracker access. Only `info` and `warn` modes are allowed, so results cannot change the run status. Inapplicable checks record n/a; checks that cannot run record an empty result. Results enter the [check record](runs.md#the-check-record). <!-- code: src/workflow.ts#transition src/run/evaluate.ts#runEndedChecks -->

The run budget includes session and judge costs. A running run stops after a try that exceeds `usd-per-run`; end-check costs are recorded after it ends. <!-- code: src/run/settle.ts#readRunSpend src/trace.ts#getRunSpend src/run/drive.ts#runWorkflow -->

`agi check <name>... --runs` does the same on ended runs, `info` checks as `info` and the rest as `warn`; `--workflow` and `--issue` narrow the runs. A check with a later result under its current version is skipped. <!-- code: src/run/evaluate.ts#runLaterChecks --> The studio marks these results "checked later".

A `reads: traces` check gets an empty folder beside the run's traces, so it works on runs whose kept files are gone.

## The Results tab

The studio's `/results` page shows each run's latest results under current check versions, falling back to older results marked `older`. Run labels provide grouping dimensions. <!-- code: bin/results.ts#readRunResults studio/src/results/ResultsPage.tsx#ResultsPage src/results.ts#ResultSheet src/trace.ts#findLatestChecks studio/src/results/ResultTable.tsx#RunResultLines -->

The table summarizes each result field and its passing values; the chart compares fields over time or by labels. Dead runs are hidden by default. <!-- code: src/results.ts#findCheckFields bin/results.ts#findDeadReason -->

Every run also gets a `humans` row from its trace: comments, reviews, label changes and review requests by people (once each, no bots), and `waitSeconds` spent waiting on a person, not on an engine error or child run (`openWaitSeconds` while still waiting). Runs without a record from their start show `coverage` `missing` or `partial` and no values. <!-- code: src/results.ts#sumHumanInteractions bin/results.ts#readRunResults src/types.ts#isWaitingOnPeople -->

A run's page shows failed gates and field values, marked as checked at run end or later.

## Reading traces

`reads: traces` supplies read-only `traces.md` with the issue's other runs, excluding retros: prompts, tool calls, replies, checks and outcomes. Trace line numbers support citations. Long histories are shortened and known secrets redacted. <!-- code: src/context.ts#transcript -->

Scripts get the same file as `AGENTGRAPH_TRACES`, so a script can check, for example, that tests ran after the last edit. <!-- code: src/run/check.ts#writeTraces -->

For example, a trace-reading judge can check whether the reported work happened:

```yaml
# checks/claims.md
mode: warn
agent: auditor
---
Did the implementor do what its reply says it did?
```

The studio marks checks and steps that read traces. <!-- code: src/graph.ts#makeWorkflowGraph -->
