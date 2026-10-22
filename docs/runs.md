# Runs

One run is one workflow on one issue. Its records live under `AGENTGRAPH_DATA`:

```
$AGENTGRAPH_DATA/
  <run id>/run.json       current state
  <run id>/trace.jsonl    append-only events
  mirror.git             bare repo mirror
  work/<id>/             temporary checkout
  index/<id>, news/<id>/  checkout index and news file
  homes/<id>/            private harness history
  logs/<sha256>.gz        full check output, shared by content
  .locks/                locks for runs being driven
```

Run ids combine workflow name, issue number and timestamp, sorting by start time.

## run.json

| Field | Meaning |
| --- | --- |
| `id`, `workflow`, `issue` | Run, workflow and issue identifiers |
| `step` | Current step |
| `status` | `running`, `waiting`, `done` or `stopped` |
| `tries`, `rounds` | Step attempts and return counts |
| `sessions` | Kept session per step |
| `feedback`, `reason` | Next-try feedback and wait/stop reason |
| `answers` | Human answers paired with questions |
| `comment`, `said` | Status comment id and human reply locations |
| `base` | Stacked parent pull request and base head |
| `hub`, `by` | Last checked hub version and dispatching run id |
| `started`, `usd` | Start time and session cost |

`waiting` can mean human review, a question or a dispatched child; see [Waiting](loop.md#waiting) and [Dispatch](loop.md#dispatch). State is rewritten whole on each save. <!-- code: src/workflow.ts#Run -->

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind: <!-- code: src/store.ts#Trace -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, system prompt, prompt and tools |
| `event` | Harness text, tool calls, usage and end events; cache tokens where reported |
| `session` | End reason, resume flag and cost |
| `check` | Result and shortened findings; fan-outs also record items. `log` identifies full output by hash and size. |
| `applied` | Proposal, success, URL or failure reason |
| `outcome` | Pass, failure, back, ask, answer or stop, and next state |
| `saved` | Changed state fields; `cleared` lists removed fields |
| `spoken` | CLI-origin event, including its source and reply location |
| `told` | Forwarded text and sender in `by`, a router run id or `cli` |

Session lines share a `key` to distinguish concurrent sessions. The studio and CLI status read these records; writes use the file store. GitHub status also checks App scope. <!-- code: src/store.ts#fileStore -->

Audit finished runs with:

```sh
node bin/traces.mjs "$AGENTGRAPH_DATA" 'issue=pull_request|push' 'triage=label|issue|ask'
```

It fails on denied tool calls, zero-cost started sessions, or done workflows lacking any listed applied kind. It also prints wait time before the first session. It reads run data only and is outside precommit.

## Provenance

Posted comments, replies, issues and pull requests end with hidden `<!-- agentgraph run=<id> step=<step> session=<id> at=<time> -->`. With `AGENTGRAPH_STUDIO_URL`, a `⁂` links to `<studio>/runs/<id>?at=<time>`. The engine replaces agent-written markers and records the same `at` on `applied`. <!-- code: src/forge.ts#stamp -->

`/runs?gh=<link or comment id>` finds the newest matching applied write, including older runs without markers. Issue or pull request links open that issue's runs; the Runs issue box also accepts GitHub links. Writes offer `copy link`; graph links select the write's step, otherwise the current step. <!-- code: src/store.ts#locate -->

## Check logs

Script output and judges' final replies are gzipped in shared `logs/`, deduplicated by sha256. Traces and GitHub show short findings; studio check rows open full output. `AGENTGRAPH_CHECK_LOGS` is a runner setting: `all` by default, `failed` for failures only, `off` for none.

```sh
node bin/run.ts prune-logs --data <dir>
node bin/run.ts prune-logs --data <dir> --apply
```

The first counts unreferenced logs; the second deletes them. Run while no runs are being driven. <!-- code: src/store.ts#checkLogs src/store.ts#Log src/store.ts#pruneLogs -->

## Checkout

Runs use mirror checkouts on workflow branches. Scope exit removes the checkout, saving files at `refs/agentgraph/runs/<run id>` for resumption. Mirror refs are read only inside the sandbox. <!-- code: src/docker.ts#docker -->

## Stopping early

[Limits and runner errors](loop.md#order-and-limits) determine stopping versus waiting for retry. The status comment carries the reason; the trace carries details. Closing an issue stops its live run.
