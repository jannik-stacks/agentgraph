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

A data folder inside the repo is refused. A moved repo is a new instance. A run id is the workflow name, the issue number and a timestamp. <!-- code: src/instance.ts#ensureInstance -->

## instance.yaml

Written by the first command in a repo. <!-- code: src/instance.ts#Instance -->

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | the repo | The checkout the base syncs from and branches go to |
| `base` | the branch checked out first | The branch agentgraph's base fast-forwards to |
| `owner` | `git config user.name` at the first command, else your OS user | The author of every local verb and the only trusted login |
| `provider` | none | The saved [provider](cli.md#picking-a-provider) |
| `exported` | none | Where agentgraph last wrote each ref into the repo |

## The forge folder

A forge folder stands in for GitHub: `<n>.md` issues, `<n>.jsonl` timelines, `<n>/pull.json` and `diff.patch` for pull requests, and a bare `origin.git`. Unlike GitHub, it refuses a whole push that touches `.github/`. `--forge <dir>` runs the CLI on one directly. <!-- code: src/forge.ts#fileForge -->

Any `<n>.md` you write under an unused number is an issue. Frontmatter with a trusted `author` and a workflow's label starts that workflow on the next look; `agi start` writes such a file. <!-- code: src/forge.ts#writeIssueFile -->

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
| `base`, `onto` | The stacked parent's pull request, and where a conflicted follow lands |
| `graph`, `by` | Graph version last checked, and the run that dispatched this one |
| `started`, `ended` | When the run started and ended |
| `startCommit` | The commit the run's change is measured from |
| `owed` | [End checks](checks.md#end-checks) the ended run still has to run |

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind. Lines from one session share a `key`. <!-- code: src/trace.ts#Trace src/store.ts#fileStore -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, system prompt, prompt and tools |
| `event` | Harness start (with provider and model), text, tool calls with `ms`, usage and end |
| `session` | End reason, whether it resumed, and cost |
| `setup` | `ms` and `exit` of setup in a checkout |
| `env`, `cache` | The [environment](sandbox.md#environments) a checkout used, and files it cached |
| `applied` | A proposal with its URL or why it failed |
| `outcome` | Pass, failure, back, ask, answer or stop, and the next state |
| `saved` | Changed state fields; `cleared` lists removed ones |
| `spoken` | A CLI command, where it came from and where to reply |
| `told` | Forwarded text, with the sender in `by`: a router run id or `cli` |

`node bin/traces.mjs "$AGENTGRAPH_DATA" 'issue=pull_request|push'` fails on denied tool calls, sessions that cost nothing, and finished workflows without their listed applied kinds.

## The check record

Each `checks.jsonl` line is one result: `at`, `step`, the check's `version`, the result with short findings, `value`, `share` or `empty`, the item, and `usd`, the judging cost. `later` marks a result from [`check --runs`](checks.md#end-checks), and `log` points at the full output. <!-- code: src/trace.ts#CheckEntry src/store.ts#fileStore -->

The version hashes the check's file, its judge's file and the graph's scripts. Readers take each check's newest result under its current version, else its newest, marked as older. A run's cost sums its sessions; its checking cost sums its check record. <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Run links

Every comment, issue and pull request the bot posts ends with a hidden `<!-- agentgraph run=<id> step=<step> session=<id> operation=<key> at=<time> -->`. With `AGENTGRAPH_STUDIO_URL` set, a `⁂` links to the run in the studio, and `/runs?gh=<link or comment id>` finds the run behind a write. <!-- code: src/forge.ts#formatBodyWithRunLink src/store.ts#locate -->

A runner that stops between posting and recording finds the post by its operation key and does not post again. <!-- code: src/engine.ts#findAppliedBefore -->

## Check logs

Each check's full output, the last 64K characters of a script's output or a judge's transcript, is gzipped in `logs/`, one file per distinct content. `AGENTGRAPH_CHECK_LOGS` keeps `all` (default), only `failed`, or `off`. `agi prune-logs --data <dir>` counts logs no check record names, and `--apply` deletes them; run it while nothing is driven. <!-- code: src/store.ts#checkLogs src/trace.ts#Log src/store.ts#pruneLogs -->

## Checkouts

A run works in a checkout from the mirror. When the engine is done with it, it saves the files at `refs/agentgraph/runs/<run id>` for resuming and removes it. <!-- code: src/docker.ts#dockerSandbox -->
