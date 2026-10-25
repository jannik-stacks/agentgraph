# Runs

A run is one workflow on one issue. Its records live in the data directory, `AGENTGRAPH_DATA`:

```
$AGENTGRAPH_DATA/
  <run id>/run.json       current state
  <run id>/trace.jsonl    append-only events
  mirror.git              bare mirror of the repo
  work/<id>/              checkouts in use
  index/<id>, news/<id>/  checkout index and news file
  homes/<id>/             private harness homes, kept for resuming
  logs/<sha256>.gz        full check output, shared by content
  .locks/                 locks of runs being driven
```

A run id is the workflow name, the issue number and a timestamp.

## run.json

| Field | Meaning |
| --- | --- |
| `id`, `workflow`, `issue` | The run, its workflow and its issue |
| `title`, `body` | The issue text as the run last saw it |
| `step`, `status` | Current step; `running`, `waiting`, `done` or `stopped` |
| `tries`, `rounds` | Attempts at this step and returns per step |
| `sessions` | The kept session of each step |
| `feedback`, `reason` | Feedback for the next try, and why the run waits or stopped |
| `answers` | Human answers, each with its question |
| `comment`, `said` | The status comment, and where people last spoke |
| `base`, `onto` | The stacked parent's pull request, and the base a conflicted follow lands on |
| `hub`, `by` | Hub version last checked, and the run that dispatched this one |
| `started`, `ended`, `usd` | Times and session cost, judges of end checks included |
| `owed` | [End checks](loop.md#at-run-end-and-later) the ended run has yet to run |

<!-- code: src/workflow.ts#Run -->

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind: <!-- code: src/trace.ts#Trace -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, system prompt, prompt and tools |
| `event` | Harness text, tool calls with `ms` where the harness reports it, usage and end |
| `session` | End reason, whether it resumed, and cost |
| `check` | Result and short findings, a number check's `value` or `empty`, the fan-out item, `end` for an end check, and `log`, the hash and size of the full output |
| `setup` | `ms` and `exit` of the hub setup in a checkout |
| `env`, `cache` | The [environment](sandbox.md#environments) a checkout started from, and how many files it wrote to the cache |
| `applied` | A proposal with its URL or failure reason |
| `outcome` | Pass, failure, back, ask, answer or stop, and the next state |
| `saved` | Changed state fields; `cleared` lists removed ones |
| `spoken` | A CLI command, with where it came from and where to reply |
| `told` | Forwarded text, with the sender in `by`: a router run id or `cli` |

Lines from one session share a `key`, so concurrent sessions stay apart. <!-- code: src/store.ts#fileStore -->

`bin/traces.mjs` audits finished runs:

```sh
node bin/traces.mjs "$AGENTGRAPH_DATA" 'issue=pull_request|push' 'triage=label|issue|ask'
```

It fails on denied tool calls, started sessions that cost nothing, and finished workflows without any of their listed applied kinds. It also prints how long each run waited before its first session.

## Run links

Every comment, reply, issue and pull request the bot posts ends with a hidden `<!-- agentgraph run=<id> step=<step> session=<id> operation=<key> at=<time> -->`. With `AGENTGRAPH_STUDIO_URL` set, a `⁂` links to `<studio>/runs/<id>?at=<time>`, and the trace's `applied` line has the same `at`. <!-- code: src/forge.ts#stamp -->

The operation key names one write of one try: the run, step, try, round, target and proposal. The engine posts first and records the `applied` line after. When a runner stops between the two, the resumed try finds the post by its key, records it and does not post it again. This covers comments, review replies and issues in both forges; a pull request is already found by its branch. <!-- code: src/engine.ts#findAppliedBefore src/github.ts#githubForge src/forge.ts#fileForge -->

In the studio, `/runs?gh=<link or comment id>` opens the run that made a write, and an issue or pull request link opens that issue's runs. <!-- code: src/store.ts#locate -->

## Check logs

The output of each check is gzipped in `logs/`, one file per distinct content: the last 64K characters of a script's output, or a judge's whole final reply. Traces and GitHub show short findings, and the studio's check rows open the full output. `AGENTGRAPH_CHECK_LOGS` keeps `all` (default), only `failed`, or `off`.

`npx agentgraph prune-logs --data <dir>` counts logs no trace refers to; `--apply` deletes them. Run it while no run is being driven. <!-- code: src/store.ts#checkLogs src/trace.ts#Log src/store.ts#pruneLogs -->

## Checkout

A run works in a checkout from the mirror on its workflow branch. When the engine is done with a checkout, it saves the files at `refs/agentgraph/runs/<run id>` for resuming and removes it. Inside the sandbox the mirror is read only. <!-- code: src/docker.ts#dockerSandbox -->

[Limits and runner errors](loop.md#order-and-limits) decide whether a run stops or waits. The status comment carries the reason and the trace the details.
