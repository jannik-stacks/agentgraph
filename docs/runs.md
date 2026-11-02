# Runs and data

A run is one workflow on one issue. Its status is `running`, `waiting` (a question, tries or rounds used up, or a runner error), `done` or `stopped` (a stop, a closed issue, a removed trigger label or the spend limit).

## The data folder

Locally, each repo gets an instance under the data root. As a runner (`--forge`), `--data` is the runs folder itself.

```
~/.agentgraph/                      --data, else AGENTGRAPH_DATA
  left-pad-7c1e2a-local/            <repo folder>-<hash of its path>-local, the instance's records
    instance.yaml                   repo, base, owner, provider, refs written into the repo
    forge/                          issues, timelines, origin.git (the checkouts' git and run refs)
    data/                           the runs folder:
      <run id>/run.json               current state
      <run id>/trace.jsonl            append-only events
      files/<sha256>                  uploaded files
      homes/<id>/                     harness homes, kept for resuming and forking
      logs/<sha256>.gz                full check output, shared by content
      .locks/                         locks of runs being driven
      cache/                          rebuilt on demand: graphs/, work/, index/, news/, scratch/, sync/
```

A data folder inside the repo is refused. A moved repo is a new instance. A run id is the workflow name, the issue number and a timestamp. <!-- code: src/instance.ts#ensureInstance -->

## Backup and restore

An instance folder holds every record of its repo; a runner's runs folder holds every record of the runner, with `mirror.git` keeping its run refs. Anything under `cache/` comes back on the next run, as do Docker images and dependency volumes. Back up while no loop or run is driving, so the SQLite files in harness homes are copied with their `-wal` files intact:

```sh
tar -czf left-pad.tgz -C ~/.agentgraph --exclude left-pad-7c1e2a-local/data/cache left-pad-7c1e2a-local
restic backup ~/.agentgraph/left-pad-7c1e2a-local --exclude ~/.agentgraph/left-pad-7c1e2a-local/data/cache
```

Restore by unpacking into the data root, `tar -xzf left-pad.tgz -C ~/.agentgraph`, with the repo at the same path, since the folder name and `instance.yaml` name it. Homes may also hold a harness's own `.cache/` or `.npm/`, which a backup may skip too. <!-- code: src/docker.ts#dockerSandbox src/instance.ts#ensureGraph -->

Folders made before `cache/` existed move by hand, with nothing driving:

```sh
cd ~/.agentgraph/left-pad-7c1e2a-local
mkdir -p data/cache && mv graphs data/cache/
for d in work index news scratch sync; do [ -e data/$d ] && mv data/$d data/cache/; done
git --git-dir forge/origin.git worktree prune
```

A runner's runs folder moves the same way, without `graphs`, then prunes `mirror.git` instead.

## instance.yaml

Written by the first command in a repo. <!-- code: src/instance.ts#Instance -->

| Field | Default | Meaning |
| --- | --- | --- |
| `repo` | the repo | The checkout the base syncs from and branches go to |
| `base` | the branch checked out first | The branch agentgraph's base fast-forwards to |
| `owner` | `git config user.name` at the first command, else your OS user | The author of every local verb and the only trusted login |
| `provider` | none | The saved [provider](cli.md#picking-a-provider) |
| `exported` | none | Where agentgraph last wrote each ref into the repo |
| `readonly` | off | `true` writes nothing to the repo; `--read-only` sets it |

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
| `meta` | Public JSON keyed by owner, including engine provenance |
| `owed` | [End checks](checks.md#end-checks) the ended run still has to run |

## Metadata

Run and result-row `meta` holds public JSON keyed by plugin name. Each owner decodes its key with
its own Effect Schema. `meta.engine.origin` has `plugin`, `version`, `job` and `input`; it cannot
change after creation. Equality follows the stored JSON: object prototypes and negative zero do not survive encoding. `meta.engine.continued` adds `at` for the latest accepted caller input.
Results can group by the origin's plugin/job and show each owner's JSON under Run metadata.
<!-- code: src/meta.ts#PluginMetadata src/meta.ts#getRunOrigin src/store.ts#fileStore -->

Each owner has at most 8 KiB and the whole field 32 KiB of UTF-8 JSON. Names start with a letter,
then letters, digits or underscores. Values use finite numbers and plain JSON, nested at most
32 containers. Cycles, unsupported values and oversized metadata fail before persistence.
Never put credentials or secrets here: metadata reaches the studio and traces. Validation checks
shape and size, not secrecy. Owner names are conventions for trusted host code, not permissions.
Issues and events have no metadata field.

Programmatic `start({ graph, issue, data, meta })` tags new runs before their first save.
`instruct(graph, instruction, meta)` also accepts metadata. A spoken trace keeps it while an input
waits; only an accepted input updates the run's latest continuation. Origin stays unchanged.
Ordinary polls and rejected inputs add no continuation. Bench replays use this same start path.
<!-- code: src/main.ts#start src/engine.ts#instruct src/engine.ts#tick src/meta.ts#makeContinuedMeta -->

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind. Lines from one session share a `key`. <!-- code: src/trace.ts#Trace src/store.ts#fileStore -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, system prompt, prompt and tools |
| `event` | Harness start (with provider and model), text, tool calls with `ms`, usage and end |
| `session` | End reason, whether it resumed, cost, and `used` |
| `setup` | `ms`, `exit` and `used` of setup in a checkout |
| `env`, `cache` | The [environment](sandbox.md#environments) a checkout used, and files it cached |
| `applied` | A proposal with its URL or why it failed |
| `outcome` | Pass, failure, back, ask, answer or stop, and the next state |
| `saved` | Changed state fields; `cleared` lists removed ones |
| `spoken` | A CLI command, where it came from and where to reply |
| `told` | Forwarded text, with the sender in `by`: a router run id or `cli` |

`used` is what the command's container reported from its cgroup as it exited: `peak` memory in bytes, `cpu` time in ms, and `oom` when the kernel killed a process of it for memory. It is missing when the container reported nothing, as on cgroup v1, after a timeout, or from a box server. Studio shows it on the session, setup and check rows. <!-- code: src/docker.ts#dockerArgs src/sandbox.ts#Exit studio/src/runs/rows.tsx -->

`node bin/traces.mjs "$AGENTGRAPH_DATA" 'issue=pull_request|push'` fails on denied tool calls, sessions that cost nothing, and finished workflows without their listed applied kinds.

## The check record

Each `checks.jsonl` line is one result: `at`, `step`, the check's `version`, the result with short findings, `value`, `share` or `empty`, the item, `usd`, the judging cost, and a script's `exit` and `used`. `later` marks a result from [`check --runs`](checks.md#end-checks), and `log` points at the full output. <!-- code: src/trace.ts#CheckEntry src/store.ts#fileStore -->

The version hashes the check's file, its judge's file and the graph's scripts. Readers take each check's newest result under its current version, else its newest, marked as older. A run's cost sums its sessions; its checking cost sums its check record. <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Run links

Every comment, issue and pull request the bot posts ends with a hidden `<!-- agentgraph run=<id> step=<step> session=<id> operation=<key> at=<time> -->`. A collapsed ⁂ footer sits before the marker, even with no extra content. With `AGENTGRAPH_STUDIO_URL` set, the ⁂ links to the run in the studio, and `/runs?gh=<link or comment id>` finds the run behind a write. <!-- code: src/forge.ts#formatBodyWithRunLink src/store.ts#locate -->

A runner that stops between posting and recording finds the post by its operation key and does not post again. <!-- code: src/engine.ts#findAppliedBefore -->

## Check logs

Each check's full output, the last 64K characters of a script's output or a judge's transcript, is gzipped in `logs/`, one file per distinct content. `AGENTGRAPH_CHECK_LOGS` keeps `all` (default), only `failed`, or `off`. `agi prune-logs --data <dir>` counts logs no check record names, and `--apply` deletes them; run it while nothing is driven. <!-- code: src/store.ts#checkLogs src/trace.ts#Log src/store.ts#pruneLogs -->

## Checkouts

A run works in a checkout, a worktree of the forge's `origin.git` in a local instance, or of `mirror.git` in the runs folder on a runner. Its admin dir stays in that repo and its files in `cache/work/`; neither is in your repo. When the engine is done with it, it saves the files at `refs/agentgraph/runs/<run id>` for resuming and removes it. After every attempt, failed or empty ones too, it also commits the files at `refs/agentgraph/attempts/<run id>/<n>`, so a retry never overwrites an earlier try. A runner that starts finds the checkouts of runners that died, commits each at `refs/agentgraph/reaped/<checkout id>` and only then removes it; one it cannot save stays in `cache/work/` with a warning. <!-- code: src/docker.ts#dockerSandbox src/engine.ts#drive src/git.ts#commitCheckoutOnce -->
