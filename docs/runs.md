# Runs and data

A run is one workflow on one issue. Its status is `running`, `waiting` (a question, tries or rounds used up, or a runner error), `done` or `stopped` (a stop, a closed issue, a removed trigger label or the spend limit).

## The data folder

Locally, each repo gets an instance under the data root. As a runner (`--forge`), `--data` is the runs folder itself.

```
~/.agentgraph/                      --data, else AGENTGRAPH_DATA
  left-pad-7c1e2a-local/            <repo folder>-<hash of its path>-local
    instance.yaml                   repo, base, owner, provider, refs written into the repo
    forge/                          issues, timelines, origin.git
    graphs/                         committed graph versions
    data/                           the runs folder:
      <run id>/run.json               current state
      <run id>/trace.jsonl            append-only events
      mirror.git                      bare mirror of the repo
      work/<id>/                      checkouts in use
      index/<id>, news/<id>/          checkout index and news file
      homes/<id>/                     harness homes, kept for resuming
      logs/<sha256>.gz                full check output, shared by content
      .locks/                         locks of runs being driven
```

A data folder inside the repo is refused. A moved repo is a new instance; `agi show` outside a repo marks instances whose repo is gone. A run id is the workflow name, the issue number and a timestamp. <!-- code: src/instance.ts#ensureInstance -->

## instance.yaml

Written by the first command in a repo. <!-- code: src/instance.ts#Instance -->

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | the repo | The checkout the base syncs from and branches go to |
| `base` | the branch checked out first | The branch agentgraph's base fast-forwards to |
| `owner` | `git config user.name` | The author of every local verb and the only trusted login |
| `provider` | none | The saved [provider](cli.md#picking-a-provider) |
| `exported` | none | Where agentgraph last wrote each ref into the repo |

## The forge folder

A forge folder stands in for GitHub. It holds `<n>.md` issues, `<n>.jsonl` timelines, `<n>/pull.json` and `diff.patch` for pull requests, and a bare `origin.git`. Unlike GitHub, it refuses a whole push that touches `.github/`, and a second `pull_request` for a branch leaves the open one as it is. `--forge <dir>` runs the CLI on one directly, for tests and the bench. <!-- code: src/forge.ts#fileForge -->

Any `<n>.md` you write there under an unused number is an issue: the first line is the title, the rest the body. To start a workflow, add frontmatter with an `author` and the workflow's label. The next look starts the run when the author is trusted. `agi start` writes such a file. <!-- code: src/forge.ts#writeIssueFile -->

```md
---
title: Reject a negative count
author: morgan
labels: [agent:ready]
---

count(-1) should throw.
```

## run.json

<!-- code: src/workflow.ts#Run -->

| Field | Meaning |
| --- | --- |
| `id`, `workflow`, `issue` | The run, its workflow and its issue |
| `title`, `body` | The issue text as the run last saw it |
| `step`, `status` | Current step and status |
| `tries`, `rounds` | Attempts at this step, and returns per step |
| `sessions` | The kept session of each step |
| `feedback`, `reason` | Feedback for the next try, and why the run waits or stopped |
| `answers` | Human answers, each with its question |
| `comment`, `said` | The status comment, and where people last spoke |
| `base`, `onto` | The stacked parent's pull request, and the base a conflicted follow lands on |
| `graph`, `by` | Graph version last checked, and the run that dispatched this one |
| `started`, `ended`, `usd` | Times and session cost, end check judges included |
| `startCommit` | The commit the run's change is measured from |
| `owed` | [End checks](checks.md#end-checks) the ended run still has to run |

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind. Lines from one session share a `key`. <!-- code: src/trace.ts#Trace src/store.ts#fileStore -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, system prompt, prompt and tools |
| `event` | Harness start (with provider and model), text, tool calls with `ms`, usage and end |
| `session` | End reason, whether it resumed, and cost |
| `check` | Result and short findings, `value` or `empty`, the item, `end` for an end check, and `log`, the hash and size of the full output |
| `setup` | `ms` and `exit` of setup in a checkout |
| `env`, `cache` | The [environment](sandbox.md#environments) a checkout used, and how many files it wrote to the cache |
| `applied` | A proposal with its URL or why it failed |
| `outcome` | Pass, failure, back, ask, answer or stop, and the next state |
| `saved` | Changed state fields; `cleared` lists removed ones |
| `spoken` | A CLI command, where it came from and where to reply |
| `told` | Forwarded text, with the sender in `by`: a router run id or `cli` |

`node bin/traces.mjs "$AGENTGRAPH_DATA" 'issue=pull_request|push'` audits finished runs. It fails on denied tool calls, sessions that cost nothing, and finished workflows without any of their listed applied kinds.

## The check record

Each `checks.jsonl` line is one check result: `at`, `step`, the check's `version`, the result with its short findings, a number check's `value`, `share` or `empty`, the fan-out item, and `usd`, what judging it cost at list price. `later` marks a result from [`check --runs`](loop.md#at-run-end-and-later). `log` is the hash and size of the full output, or of the judge's transcript. Lines are only added; nothing is totalled. <!-- code: src/trace.ts#CheckEntry src/store.ts#fileStore -->

The version is a hash of the check's file, its judge's file and the graph's scripts. Readers take each check's newest whole-check result under its current version, else its newest, marked as older. A run's own cost is the sum of its trace's sessions, and its checking cost the sum of its check record. <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Results

The studio's Results tab at `/results` shows what checks gave, from one of three sources: the data dir's runs, the bench's bot arms or every tune's candidates, as the [studio](local.md) was started with. Each run counts with each check's latest result.

The table has one row per field of a check's result, with how many runs gave it, how many failed results and values past the check's `pass` limit, the median, a strip with one dot per run, and a trend by day, by tens of runs or, for tunes, by iteration. `by` splits each field by a dimension such as workflow, model or tune. A field's `unit` in `returns` (`usd`, `minutes`, `seconds`, `tokens` or `share`) sets how it reads. Runs that ended before any step passed or any session started are dead; they are counted apart and left out unless shown. The chart draws one field against time, order, a dimension or another field, colored and faceted by dimensions, with a dot per run that links to it.

A run's page shows two lines: the gates whose result failed, with the fields past their limit, and every field's value, with "at run end" or "checked later" and a link to the tab filtered to that run. <!-- code: bin/results.ts#readRunResults studio/src/results/ResultsPage.tsx#ResultsPage -->

## Run links

Every comment, issue and pull request the bot posts ends with a hidden `<!-- agentgraph run=<id> step=<step> session=<id> operation=<key> at=<time> -->`. With `AGENTGRAPH_STUDIO_URL` set, a `⁂` links to `<studio>/runs/<id>?at=<time>`. In the studio, `/runs?gh=<link or comment id>` opens the run that made a write. <!-- code: src/forge.ts#formatBodyWithRunLink src/store.ts#locate -->

The engine posts first and records the `applied` line after. If a runner stops between the two, the resumed try finds the post by its operation key and does not post it again. <!-- code: src/engine.ts#findAppliedBefore -->

## Check logs

The output of each check is gzipped in `logs/`, one file per distinct content: the last 64K characters of a script's output, or a judge's final reply. Traces and GitHub show short findings, and the studio opens the full output. `AGENTGRAPH_CHECK_LOGS` keeps `all` (default), only `failed`, or `off`. `agi prune-logs --data <dir>` counts logs no trace names, and `--apply` deletes them; run it while nothing is driven. <!-- code: src/store.ts#checkLogs src/trace.ts#Log src/store.ts#pruneLogs -->

## Checkouts

A run works in a checkout from the mirror on its workflow branch. When the engine is done with a checkout, it saves the files at `refs/agentgraph/runs/<run id>` for resuming and removes it. <!-- code: src/docker.ts#dockerSandbox -->
