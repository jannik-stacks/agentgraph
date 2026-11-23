# Checks and results

A check evaluates a [try or an ended run](index.md#terms). It can run a script, ask a judge (an agent that records a result), or do both. A step runs its checks in parallel and receives their findings together. The check's mode determines what happens next. See the [field reference](reference.md#checks). <!-- code: src/run/check.ts#runStepChecks src/run/check.ts#runOneCheck src/types.ts#Check -->

| Mode | How the step uses the result |
| --- | --- |
| `info` | Records a measurement and allows the step to continue. |
| `warn` | Records a failure and allows the step to continue. |
| `block` | Fails the try and sends the findings back to the step. |
| `stop` | Stops the run if the check fails. |

<!-- code: src/result.ts#CheckMode src/run/check.ts#runStepChecks -->

## Results

By default a judge reports a boolean `pass` and findings in `why`. A script check without an explicit `returns` passes on exit 0 and uses its output as findings. With `returns`, the last output line must be a JSON object matching the schema. The check's `pass` schema decides which valid values pass. By default it requires `pass` to equal `true`. An `info` check cannot set a `pass` schema. See [schema syntax](reference.md#checks). <!-- code: src/result.ts#defaultReturns src/result.ts#defaultPass src/result.ts#readScriptResult src/run/check.ts#runOneCheck src/folder.ts#compile -->

This check counts tool calls in the run trace. It requires an integer count and fails above 40 calls. <!-- code: src/result.ts#findMismatch src/run/check.ts#makeScriptEnv src/run/check.ts#runOneCheck -->

```yaml
mode: block
returns: { type: object, required: [calls], properties: { calls: { type: integer } } }
pass: { properties: { calls: { maximum: 40 } } }
run: jq -cs '{calls: map(select(.event.type == "tool")) | length}' "$AGENTGRAPH_RUN_TRACE"
```

Custom results keep their `value`. A check with `each` also records the passing fraction in `share`, except in `info` mode. An `empty` result has no usable measurement and is excluded from averages. An unreadable result fails a check unless its mode is `info`. If there are no items to check, the check passes and records an empty result with a reason. <!-- code: src/run/check.ts#runOneCheck src/types.ts#CheckResult src/results.ts -->

## Judges

A judge submits its value through the `result` tool. If the session ends without a result, the engine asks again when it can resume the session. It also retries a session failure once. If the judge still supplies no result, a `block` or `stop` check raises an [engine error](workflows.md#engine-errors). An `info` or `warn` check records the missing value. <!-- code: src/run/execute.ts#runJudge src/result.ts#makeResultServer src/run/check.ts#runOneCheck -->

With `each`, a judge evaluates items separately. A failed item, more items than `max`, or a failure in the command that lists items produces findings. The check's mode determines whether the step continues. See [session reuse](reference.md#sessions). <!-- code: src/run/check.ts#runOneCheck src/run/check.ts#runStepChecks -->

A judge can reuse a passing result within one run while the engine process and store stay open. The diff, prompt and judge settings must still match. A changed answer changes the prompt. Checks that read traces or declare custom result schemas always ask the judge again. The cache lives in memory, so a process restart or a new run starts with no saved passes. <!-- code: src/run/check.ts#passes src/run/check.ts#runOneCheck -->

## Script variables

Scripts execute in the checkout. In this table, “all scripts” includes checks, script steps, setup and the `each` command that lists items. See [network access](sandbox.md#the-network). <!-- code: src/run/check.ts#makeScriptEnv src/run/check.ts#getCheckFiles src/run/checkout.ts#runSetup src/run/checkout.ts#findFanOutItems -->

| Variable | Contents | Recipients |
| --- | --- | --- |
| `AGENTGRAPH_BASE` | Starting commit or branch fork point | All scripts and agent sessions |
| `AGENTGRAPH_DIR` | Path to the read-only graph inside the sandbox | All scripts |
| `AGENTGRAPH_ISSUE` | Issue number | Checks and script steps |
| `AGENTGRAPH_PROPOSALS` | Path to the JSON file of pending proposals | Checks |
| `AGENTGRAPH_CONTEXT` | Path to issue, pull request and answer text | Checks |
| `AGENTGRAPH_REPLY` | Path to the step's reply | Checks |
| `AGENTGRAPH_TRACES` | Path to the [issue transcript](#reading-traces) | Checks and script steps with `reads: traces` |
| `AGENTGRAPH_RUN_TRACE` | Path to this run's JSON trace, one event per line | Checks and script steps with `reads: traces` |
| `AGENTGRAPH_ITEM` | Current `each` item | Checks |
| `AGENTGRAPH_FROM` | [Previous base](workflows.md#when-the-base-or-the-graph-moves) | Checks during a base update |

<!-- code: src/run/check.ts#makeScriptEnv src/run/check.ts#getCheckFiles src/run/check.ts#getTraceFiles src/run/check.ts#runOneCheck src/run/checkout.ts#runSetup src/run/attempt.ts#runAttempt src/sandbox.ts#inside -->

## End checks

Workflow-level `checks` inspect the run after it ends, in a temporary checkout without tracker access. Use `info` or `warn`. These checks leave the run's status alone. A result marked `n/a` means the check did not apply, for example because it needs saved changes and the run kept none. A check that cannot run records an `empty` result and a reason. See the [check record](runs.md#the-check-record). <!-- code: src/workflow.ts#compileWorkflow src/run/evaluate.ts#whyNotApplicable src/run/evaluate.ts#runEndedChecks -->

Use `agi check <name>... --runs` to evaluate ended runs. It keeps `info` mode and uses `warn` for other modes. Use `--workflow` and `--issue` to narrow the selection. A check already recorded at or after the end with its current version is skipped. The studio marks new results “checked later”. A check with `reads: traces` can use a recorded session even if the run kept no checkout changes. <!-- code: src/run/evaluate.ts#runLaterChecks src/run/evaluate.ts#reopen src/run/evaluate.ts#whyNotApplicable src/run/trigger.ts#instruct studio/src/results/ResultTable.tsx -->

## The Results tab

The Results tab at `/results` shows the latest result for the current check version. When only past versions have results, it shows them as `older`. Open a run to inspect failed checks, their values and when they ran. Labels group runs. Tables summarize values and passing results. Charts compare them over time or across labels. The page hides dead runs by default. <!-- code: bin/results.ts#readRunResults bin/results.ts#findDeadReason src/trace.ts#findLatestChecks studio/src/runs/rows.tsx studio/src/results/ResultsPage.tsx#ResultsPage studio/src/results/ResultTable.tsx#RunResultLines -->

The `humans` result counts each person's `comments`, `reviews`, `labels` and `requests` once per event. Its `waitSeconds` excludes waits for engine errors and child runs. The `openWaitSeconds` value counts ongoing human waits. Incomplete records show `coverage` as `missing` or `partial` and omit the measurements. Other records show `complete`. <!-- code: src/results.ts#sumHumanInteractions bin/results.ts#readRunResults src/types.ts#isWaitingOnPeople -->

## Reading traces

With `reads: traces`, the engine writes a read-only `traces.md` transcript for runs on the issue, excluding feedback workflows. It includes prompts, calls, replies, checks and outcomes. Use the run and line number to cite an entry. The engine shortens long histories and redacts known secrets. Scripts can read the transcript at `AGENTGRAPH_TRACES`. <!-- code: src/context.ts#transcript src/run/check.ts#writeTraces src/run/check.ts#tracesPrompt -->
