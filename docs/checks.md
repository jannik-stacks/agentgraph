# Checks and results

Checks inspect tries or ended runs. Step checks run in parallel and return feedback together. <!-- code: src/run/check.ts#runStepChecks --> Use `run`, `agent` or both; see [fields](reference.md#checks). <!-- code: src/types.ts#Check src/result.ts#CheckMode -->

| Mode | Failure |
| --- | --- |
| `info` | Record only; never fails |
| `warn` | Record; continue |
| `block` | Fail try; feed findings back |
| `stop` | Stop run |

## Results

Without `returns`, results contain a boolean `pass` and findings in `why`. <!-- code: src/result.ts#defaultReturns --> Results must match `returns` and the `pass` schema; scripts must exit 0. The default schema requires `pass` to equal `true`. `why` never decides; `info` forbids `pass`. See [schema syntax](reference.md#checks). <!-- code: src/result.ts#defaultPass src/result.ts#findMismatch src/result.ts#whyPassUndecided -->

```yaml
mode: block
returns: { type: object, required: [calls], properties: { calls: { type: integer } } }
pass: { properties: { calls: { maximum: 40 } } }
run: jq -cs '{calls: map(select(.event.type == "tool")) | length}' "$AGENTGRAPH_RUN_TRACE"
```

Without `returns`, exit 0 passes; output supplies findings. Otherwise, the last line supplies JSON. <!-- code: src/result.ts#readScriptResult --> Custom results retain `value`; `each` records the passing `share`, except in `info` mode. <!-- code: src/run/check.ts#runOneCheck src/types.ts#CheckResult --> Invalid results fail except in `info` mode. They are marked `empty` and excluded from averages. An `each` check without items passes with an empty result and a reason. <!-- code: src/run/check.ts#runOneCheck src/run/check.ts#runStepChecks src/types.ts#CheckResult -->

## Judges

Judges submit validated `result` calls. The engine requests missing results again and retries crashes once. Without a result, `block` and `stop` park the run; `info` and `warn` record failure. <!-- code: src/run/execute.ts#runJudge src/result.ts#makeResultServer src/result.ts#resultTool src/result.ts#getRecordedResult -->

`each` judges items separately. Failed items, excess items above `max` or slicer errors fail the check. See [sessions](reference.md#sessions). Passed items may be reused while diffs and prompts match. Changed checks, answers and restarts invalidate reuse. Trace readers and custom schemas prevent reuse. <!-- code: src/run/check.ts#passes src/graph.ts#makeWorkflowGraph -->

## Script variables

Scripts use the checkout; see [network](sandbox.md#the-network). <!-- code: src/run/check.ts#runOneCheck src/run/check.ts#makeScriptEnv src/run/check.ts#getCheckFiles src/run/check.ts#getTraceFiles -->

| Variable | Contents | Recipients |
| --- | --- | --- |
| `AGENTGRAPH_BASE` | Starting commit or branch fork point | All; sessions too |
| `AGENTGRAPH_DIR` | Read-only graph | All |
| `AGENTGRAPH_ISSUE` | Issue number | Checks, `run` steps |
| `AGENTGRAPH_PROPOSALS` | Pending proposals JSON file | Checks |
| `AGENTGRAPH_CONTEXT` | Issue, pull request, answers | Checks |
| `AGENTGRAPH_REPLY` | Try reply | Checks |
| `AGENTGRAPH_TRACES` | [Issue traces](#reading-traces) file | Checks; `run` with `reads: traces` |
| `AGENTGRAPH_RUN_TRACE` | Run JSON events, one per line | Checks; `run` with `reads: traces` |
| `AGENTGRAPH_ITEM` | `each` item | Checks |
| `AGENTGRAPH_FROM` | [Previous base](workflows.md#when-the-base-or-the-graph-moves) | Checks |

“All” means checks, `run` steps, slicers and setup.

## End checks

Workflow `checks` inspect kept changes in throwaway checkouts without tracker access. Only `info` and `warn` are allowed; neither changes run status. Inapplicable checks record n/a; checks that cannot run record `empty`. See [records](runs.md#the-check-record). <!-- code: src/workflow.ts#transition src/run/evaluate.ts#runEndedChecks -->

See [run limits](workflows.md#limits-on-an-issue).

`agi check <name>... --runs` checks ended runs, keeping `info` mode and using `warn` otherwise. `--workflow` and `--issue` filter runs. Checks already evaluated later under their current version are skipped. The studio marks later results “checked later”. <!-- code: src/run/evaluate.ts#runLaterChecks --> `reads: traces` uses an empty folder beside traces, even without kept files.

## The Results tab

`/results` shows the latest results under current check versions, falling back to results marked `older`. Labels group runs. <!-- code: bin/results.ts#readRunResults studio/src/results/ResultsPage.tsx#ResultsPage src/results.ts#ResultSheet src/trace.ts#findLatestChecks studio/src/results/ResultTable.tsx#RunResultLines --> Tables summarize fields and passing values; charts compare results over time or by labels. Dead runs are hidden by default. <!-- code: src/results.ts#findCheckFields bin/results.ts#findDeadReason -->

`humans` counts people's `comments`, `reviews`, `labels` and `requests` once each. `waitSeconds` excludes waits for engine errors or child runs; `openWaitSeconds` counts ongoing human waits. Incomplete records show `coverage` as `missing` or `partial`, without values; otherwise it is `complete`. <!-- code: src/results.ts#sumHumanInteractions bin/results.ts#readRunResults src/types.ts#isWaitingOnPeople --> Run pages show failed gates, values and whether checks ran at run end or later.

## Reading traces

`reads: traces` supplies read-only `traces.md` with other issue runs, excluding retros: prompts, calls, replies, checks and outcomes. Line numbers support citations. Long histories are shortened and known secrets redacted. <!-- code: src/context.ts#transcript --> Scripts receive this file through `AGENTGRAPH_TRACES`. <!-- code: src/run/check.ts#writeTraces -->
