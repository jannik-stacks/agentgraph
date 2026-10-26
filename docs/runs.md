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
| `graph`, `by` | Graph version last checked, and the run that dispatched this one |
| `started`, `ended` | When the run started and when it ended |
| `startCommit` | The commit the run's change is measured from, as its last checkout had it |
| `owed` | [End checks](loop.md#at-run-end-and-later) the ended run has yet to run |

<!-- code: src/workflow.ts#Run -->

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind: <!-- code: src/trace.ts#Trace -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, system prompt, prompt and tools |
| `event` | A start with the harness, the provider when one was picked and the model asked for after aliases; harness text, tool calls with `ms` where the harness reports it, usage and end |
| `session` | End reason, whether it resumed, and cost |
| `setup` | `ms` and `exit` of the graph setup in a checkout |
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

## The check record

Each `checks.jsonl` line is one check result: `at`, `step`, the check's `version`, the result with its short findings, a number check's `value`, `share` or `empty`, the fan-out item, and `usd`, what judging it cost at list price. `later` marks a result from [`check --runs`](loop.md#at-run-end-and-later). `log` is the hash and size of the full output, or of the judge's transcript. Lines are only added; nothing is totalled. <!-- code: src/trace.ts#CheckEntry src/store.ts#fileStore -->

The version is a hash of the check's file, its judge's file and the graph's scripts. Readers take each check's newest whole-check result under its current version, else its newest, marked as older. A run's own cost is the sum of its trace's sessions, and its checking cost the sum of its check record. <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Results

The studio's Results tab at `/results` shows what checks gave, from one of three sources: the data dir's runs, the bench's bot arms or every tune's candidates, as the [studio](local.md) was started with. Each run counts with each check's latest result.

The table has one row per field of a check's result, with how many runs gave it, how many failed results and values past the check's `pass` limit, the median, a strip with one dot per run, and a trend by day, by tens of runs or, for tunes, by iteration. `by` splits each field by a dimension such as workflow, model or tune. A field's `unit` in `returns` (`usd`, `minutes`, `seconds`, `tokens` or `share`) sets how it reads. Runs that ended before any step passed or any session started are dead; they are counted apart and left out unless shown. The chart draws one field against time, order, a dimension or another field, colored and faceted by dimensions, with a dot per run that links to it.

A run's page shows two lines: the gates whose result failed, with the fields past their limit, and every field's value, with "at run end" or "checked later" and a link to the tab filtered to that run. <!-- code: bin/results.ts#readRunResults studio/src/results/ResultsPage.tsx#ResultsPage -->

## Run links

Every comment, reply, issue and pull request the bot posts ends with a hidden `<!-- agentgraph run=<id> step=<step> session=<id> operation=<key> at=<time> -->`. With `AGENTGRAPH_STUDIO_URL` set, a `⁂` links to `<studio>/runs/<id>?at=<time>`, and the trace's `applied` line has the same `at`. <!-- code: src/forge.ts#formatBodyWithRunLink -->

The operation key names one write of one try: the run, step, try, round, target and proposal. The engine posts first and records the `applied` line after. When a runner stops between the two, the resumed try finds the post by its key, records it and does not post it again. This covers comments, review replies and issues in both forges; a pull request is already found by its branch. <!-- code: src/engine.ts#findAppliedBefore src/github.ts#githubForge src/forge.ts#fileForge -->

In the studio, `/runs?gh=<link or comment id>` opens the run that made a write, and an issue or pull request link opens that issue's runs. <!-- code: src/store.ts#locate -->

## Check logs

The output of each check is gzipped in `logs/`, one file per distinct content: the last 64K characters of a script's output, or a judge's transcript as trace lines. Traces and GitHub show short findings, and the studio's check rows open the full output. `AGENTGRAPH_CHECK_LOGS` keeps `all` (default), only `failed`, or `off`.

`npx agentgraph prune-logs --data <dir>` counts logs no check record refers to; `--apply` deletes them. Run it while no run is being driven. <!-- code: src/store.ts#checkLogs src/trace.ts#Log src/store.ts#pruneLogs -->

## Checkout

A run works in a checkout from the mirror on its workflow branch. When the engine is done with a checkout, it saves the files at `refs/agentgraph/runs/<run id>` for resuming and removes it. Inside the sandbox the mirror is read only. <!-- code: src/docker.ts#dockerSandbox -->

[Limits and runner errors](loop.md#order-and-limits) decide whether a run stops or waits. The status comment carries the reason and the trace the details.
