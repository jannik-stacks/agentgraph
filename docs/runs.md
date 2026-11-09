# Runs and data

A run is one workflow on one issue. Its status is `running`, `waiting` (a question, tries or rounds used up, or an engine error), `done` or `stopped` (a stop, a closed issue, a removed trigger label or the spend limit).

## The data folder

Each repo gets an instance under the data root. `--data` selects that root; runs live in `<root>/<name>/data`. <!-- code: src/instance.ts#readInstance -->

```
~/.agentgraph/                      --data, else AGENTGRAPH_DATA
  left-pad/                         checkout basename, or --instance <name>
    instance.yaml                   repo, base, owner, provider, refs written into the repo
    tracker/                        issues, timelines, origin.git (the checkouts' git and run refs)
    data/                           the runs folder:
      <run id>/run.json              current state
      <run id>/checks.jsonl          check results, .zst once idle
      <run id>/trace.jsonl            append-only events, .zst once idle
      <run id>/labels.jsonl           run labels, see below
      mirror.git                      git mirror and run refs for a hosted tracker
      .envs/refs.jsonl                 environment and cache volume references
      files/<sha256>                  uploaded files
      homes/<id>/                     harness homes, kept for resuming and forking
      logs/<sha256>.gz                full check output, shared by content
      .locks/                         locks of runs being driven
      cache/                          rebuilt on demand: graphs/, work/, index/, news/, scratch/, sync/
```

<!-- code: src/disk.ts#readEnvRefs src/disk.ts#writeEnvRefs src/mirror.ts#makeSandbox src/services.ts#hostSettings src/env.ts#getCachePath src/env.ts#getCheckoutPaths -->

A data folder inside the repo is refused. An instance using a local tracker needs its `tracker/origin.git`. A name already bound to another checkout is refused; edit `checkout` in `instance.yaml` when moving the repo. A run id is the workflow name, the issue number and a timestamp. <!-- code: src/instance.ts#ensureInstance -->

Each pass of `loop` compresses `trace.jsonl` and `checks.jsonl` of a run that ended and was not written for `AGENTGRAPH_COMPRESS_DAYS` days (14) to `trace.jsonl.zst` and `checks.jsonl.zst`. Readers open either; a new line unpacks the file first. Check logs are gzipped from the start. <!-- code: src/store.ts#writeIdleRunsCompressed src/store.ts#readRecord -->

## Backup and restore

An instance folder holds every record of its repo; on GitHub, its data folder's `mirror.git` keeps the run refs. Anything under `cache/` comes back on the next run, as do Docker images and dependency volumes. Back up while no loop or run is driving, so the SQLite files in harness homes are copied with their `-wal` files intact:

```sh
tar -czf left-pad.tgz -C ~/.agentgraph --exclude left-pad/data/cache left-pad
restic backup ~/.agentgraph/left-pad --exclude ~/.agentgraph/left-pad/data/cache
```

Restore by unpacking into the data root, `tar -xzf left-pad.tgz -C ~/.agentgraph`, with the repo at the same path, since `instance.yaml` records its checkout path. Homes may also hold a harness's own `.cache/` or `.npm/`, which a backup may skip too. <!-- code: src/mirror.ts#makeSandbox src/instance.ts#ensureGraph -->

## instance.yaml

Written by the first command in a repo. Unknown fields fail. `checkout`, `graph` and `env` paths resolve against the instance folder. <!-- code: src/instance.ts#Instance src/settings.ts#InstanceFile -->

| Field             | Default                                                        | Meaning                                                                                                                                                                                           |
| ----------------- | -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `repo`            | empty                                                          | The tracker repository name                                                                                                                                                                       |
| `checkout`        | the checkout path                                              | The repo the base syncs from and branches go to                                                                                                                                                   |
| `graph`           | checkout `.agentgraph/`                                        | Graph folder; relative paths resolve against the instance folder                                                                                                                                  |
| `env`             | none                                                           | Env file; relative paths resolve against the instance folder                                                                                                                                      |
| `loop`            | `false`                                                        | Include this instance in a loop started outside a repo without `--instance`                                                                                                                       |
| `trust`           | instance owner                                                 | Trusted logins                                                                                                                                                                                    |
| `image`           | graph image                                                    | Sandbox image override                                                                                                                                                                            |
| `limits.parallel` | graph limit                                                    | Concurrent drives for this instance                                                                                                                                                               |
| `base`            | the branch checked out first                                   | The branch agentgraph's base fast-forwards to                                                                                                                                                     |
| `owner`           | `git config user.name` at the first command, else your OS user | The author of every local verb and the only trusted login                                                                                                                                         |
| `tracker`         | `folder`                                                       | The [tracker plugin](plugins.md#trackers) the instance works on, from the built-ins or its graph's `plugins/`; it keeps its files in the instance's `tracker/`, and a folder path here is refused |
| `runner`          | `local`                                                        | The [runner](sandbox.md#runners) that executes commands, from the built-ins or the host graph's `plugins/`                                                                                        |
| `provider`        | none                                                           | The saved [provider](cli.md#picking-a-provider)                                                                                                                                                   |
| `exported`        | none                                                           | Where agentgraph last wrote each ref into the repo                                                                                                                                                |
| `readonly`        | off                                                            | `true` writes nothing to the repo; `--read-only` sets it                                                                                                                                          |

## The tracker folder

A tracker folder stands in for GitHub. Each issue is a folder `<n>/` with `issue.md`, its `events.jsonl` timeline and its `reactions`; `pull.json` and `diff.patch` make it a pull request. A bare `origin.git` holds the branches. It holds changes under `.github/` for a maintainer and pushes the other files; see [Pushes](proposals.md#pushes). `--tracker <dir>` runs the CLI on one directly. <!-- code: src/tracker.ts#folderTracker -->

```
tracker/
  origin.git/
  12/issue.md, events.jsonl      no status yet
  working/14/...
  needs-review/15/...            with pull.json and diff.patch for a pull request
  done/9/...
```

An issue's status is the folder it sits in, so `ls needs-review/` shows what needs you. The engine moves the whole folder with one rename; the graph's [`status`](workflows.md#status-on-the-issue) setting names the folders, a status missing from it leaves the issue at the top, and `status: false` keeps every issue there. Open, closed and merged stay in `issue.md`'s `state`. Every read and write, the loop's and `agi say`, `review`, `close` and `merge`, takes the folder's `.tracker.lock`, so a move never loses an event and a scan never misses a moving issue. A new issue is written in a hidden `.new-*` folder that becomes its number once complete. A folder with `<n>.md` or `<n>.jsonl` files at its top is refused. <!-- code: src/tracker.ts#findIssueDir src/tracker.ts#runLocked -->

Any `<n>/issue.md` you write under an unused number is an issue. Frontmatter with a trusted `author` and a workflow's label starts that workflow on the next look; `agi start` writes such a file. <!-- code: src/tracker.ts#writeIssueFile -->

```md
---
title: Reject a negative count
author: morgan
labels: [agent:ready]
---

count(-1) should throw.
```

## run.json

<!-- code: src/types.ts#Run src/git.ts#readEngineVersions -->

Every run is saved first under a lock on its id, and only when no run has that id yet, so two passes that begin the same run save it once. The lock stays held while the engine shows the run's first status and gives its eyes reaction, so no other pass drives the run until both are saved. A new run is saved as `unshown` until its first status lands, so a later pass shows that status when the first write fails. <!-- code: src/run/start.ts#startRun --> A run another run proposes takes a fresh id when its id is taken, and the proposal fails when three ids in a row are taken. <!-- code: src/run/start.ts#startProposedRun -->

| Field                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `workflow`, `issue` | The run, its workflow and its issue; an [imported run](#imported-runs) has no issue                                                                                                                                                                                                                                                                                                                         |
| `title`, `body`           | The issue text as the run last saw it                                                                                                                                                                                                                                                                                                                                                                       |
| `step`, `status`          | Current step and status                                                                                                                                                                                                                                                                                                                                                                                     |
| `tries`, `rounds`         | Attempts at this step, and returns per step                                                                                                                                                                                                                                                                                                                                                                 |
| `sessions`                | The kept session of each step                                                                                                                                                                                                                                                                                                                                                                               |
| `feedback`, `reason`      | Context for the next try or a [retro](workflows.md#retros), and why the run waits or stopped                                                                                                                                                                                                                                                                                                                |
| `answers`                 | Human answers, each with its question                                                                                                                                                                                                                                                                                                                                                                       |
| `said`, `unshown`         | Where people last spoke, and a status the tracker has yet to show                                                                                                                                                                                                                                                                                                                                           |
| `base`, `onto`            | The stacked parent's pull request, and where a conflicted follow lands                                                                                                                                                                                                                                                                                                                                      |
| `graph`, `by`             | Graph version last checked, and the run that dispatched this one                                                                                                                                                                                                                                                                                                                                            |
| `graphTree`               | The git tree of the graph folder the run started under, kept at `refs/agentgraph/graphs/<tree>`; set once                                                                                                                                                                                                                                                                                                   |
| `versions`                | What produced the run, set once with `graphTree`: `engine`, the `git describe` of the engine checkout or else its package version; `config`, a hash of the `AGENTGRAPH_CONFIG` file when one is set; `image`, the Docker ID; and `harnesses`, the version of each graph agent's harness in that image, `unknown` when the image lacks its package. A box or plugin runner records no image and no harnesses |
| `started`, `ended`        | When the run started and ended                                                                                                                                                                                                                                                                                                                                                                              |
| `startCommit`             | The commit the run's change is measured from                                                                                                                                                                                                                                                                                                                                                                |
| `meta`                    | Public JSON keyed by owner, including engine provenance                                                                                                                                                                                                                                                                                                                                                     |
| `owed`                    | [End checks](checks.md#end-checks) the ended run still has to run                                                                                                                                                                                                                                                                                                                                           |

## Imported runs

`agi import <commit>|<patch> [<issue file>]` keeps a change made elsewhere, by a person or another tool, as an ended run so `check --runs` can score it beside the agents' runs. A commit comes from your repo and is measured from its parent; a patch is applied onto `--from`, or `HEAD`, and refused when it does not apply. The change is kept at `refs/agentgraph/runs/<run id>` in the tracker's `origin.git`. The issue file's first line becomes `title` and the rest `body`, the text a check reads. `--meta <file>` keeps its JSON as `meta.engine.origin.input`, with `plugin` `agi` and `job` `import`. <!-- code: src/instance.ts#writeImportedRun -->

An imported run has workflow `import`, status `done`, no `issue` and no trace, so checks of traces are n/a on it. Every import is a new run, even of the same change; pair runs by their origin input. Runs with no issue are left out of everything that follows issues: the loop, `show`, `resume`, `say` and the traces other runs read. Only results, the studio's Runs page and `check --runs` see them. <!-- code: src/store.ts#fileStore src/graph.ts#isOnIssue -->

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
<!-- code: src/main.ts#start src/run/trigger.ts#instruct src/run/trigger.ts#tick src/meta.ts#makeContinuedMeta -->

## Run labels

A run label is a `key=value` pair on a run. Labels live in `<run id>/labels.jsonl` beside run.json, an append-only log with one line per key set or removed; a run's labels are what the log adds up to. Keys are a-z, 0-9 and `-`, at most 32 characters; values are one line of at most 128. Labels carry no rules: nothing in the engine reads them, and adding or removing one never changes a run. The engine never writes the log after a run's start, and an edit only appends, so it races neither a run being driven nor another edit. A last line a crash cut short is skipped and counted when read, and moved to a `.partial` file beside the log before the next edit appends; a bad line before the last is an error. Each append holds a lock in the runs folder's `.locks` from that check to its write, so edits from several processes queue. <!-- code: src/owner.ts#waitForLock --> <!-- code: src/store.ts#readJsonlRows src/store.ts#appendJsonlRows -->

Readers also derive labels from the run's `versions`: `engine`, `image` (the first 12 hex digits of the ID), `config` and `harnesses`, the sorted `name@version` list such as `opencode@1.19.0,pi@1.1.0`. They are never written to the log, and a written label with the same key wins. <!-- code: src/labels.ts#makeVersionLabels bin/results.ts -->

`agi start --run-label k=v` and programmatic `start({ ..., labels })` label each run the call begins, before its first save. `agi label <run id> k=v old-` sets `k` and removes `old` at any time. Given a path such as `<store>/<run id>`, it labels that run of any store, such as a bench set's `data`. The [bench](bench.md#run-a-set) labels every run it starts, and the studio shows a run's labels, filters the Runs page by one, and keeps in the browser which label keys a reader hid. <!-- code: src/labels.ts#writeRunLabels src/main.ts#start -->

## The trace

Each `trace.jsonl` line has `at`, `step` and one kind. Lines from one session share a `key`. <!-- code: src/types.ts#Trace src/store.ts#fileStore -->

| Kind           | Contents                                                                           |
| -------------- | ---------------------------------------------------------------------------------- |
| `prompt`       | Harness, model, system prompt, prompt and tools                                    |
| `event`        | Harness start (with provider and model), text, tool calls with `ms`, usage and end |
| `session`      | End reason, whether it resumed, cost, and `used`                                   |
| `setup`        | `ms`, `exit` and `used` of setup in a checkout                                     |
| `env`, `cache` | The [environment](sandbox.md#environments) a checkout used, and files it cached    |
| `applied`      | A proposal with its URL or why it failed                                           |
| `outcome`      | Pass, failure, back, ask, answer or stop, and the next state                       |
| `saved`        | Changed state fields; `cleared` lists removed ones                                 |
| `spoken`       | A CLI command, where it came from and where to reply                               |
| `told`         | Forwarded text, with the sender in `by`: a router run id or `cli`                  |

A usage event carries `model`, the model the harness says answered, when it says one: Claude Code and pi do, opencode and codex print none. The start event's `model` stays the alias the agent asked for. Usage is priced under the reported name first, then the alias. <!-- code: src/types.ts#SessionEvent src/harnesses.ts#priced harnesses/claude.ts#claude harnesses/pi.ts#pi -->

`used` is what the command's container reported from its cgroup as it exited: `peak` memory in bytes, `cpu` time in ms, and `oom` when the kernel killed a process of it for memory. It is missing when the container reported nothing, as on cgroup v1, after a timeout, or from a box server. Studio shows it on the session, setup and check rows. <!-- code: src/docker.ts#dockerArgs src/types.ts#Exit src/remote.ts#makeBoxRunner studio/src/runs/rows.tsx -->

`node bin/traces.mjs "$AGENTGRAPH_DATA" 'issue=pull_request|push'` fails on denied tool calls, sessions that cost nothing, and finished workflows without their listed applied kinds.

## The check record

Each `checks.jsonl` line is one result: `at`, `step`, the check's `version`, the result with short findings, `value`, `share`, `empty` or `na`, the item, `usd`, the judging cost, and a script's `exit` and `used`. `later` marks a result from [`check --runs`](checks.md#end-checks), and `log` points at the full output. <!-- code: src/types.ts#CheckEntry src/store.ts#fileStore -->

The version hashes the check's file, its judge's file, its judge's harness and model, and the graph's scripts. Readers take each check's newest result under its current version, else its newest, marked as older. A run's cost sums its sessions; its checking cost sums its check record. <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Run links

Every comment, issue and pull request the bot posts ends with a hidden `<!-- agentgraph run=<id> step=<step> session=<id> operation=<key> at=<time> -->`. Its text ends with ⁂ on the line of its last sentence, or on a line of its own after a code block, table or HTML. With `AGENTGRAPH_STUDIO_URL` set, the ⁂ links to the trace entry in the studio that wrote the text, at `/<instance>/runs/<id>?at=<time>`, the same for a comment and a pull request description, and `/<instance>/runs?gh=<link or comment id>` finds the run behind a write in any instance the studio serves. <!-- code: src/tracker.ts#formatBodyWithRunLink src/event.ts#formatRunMark src/store.ts#locate src/store.ts#Located src/main.ts#readInstanceEnv -->

An engine that stops between posting and recording finds the post by its operation key and does not post again. <!-- code: src/run/settle.ts#findAppliedBefore -->

## Check logs

Each check's full output, the last 64K characters of a script's output or a judge's transcript, is gzipped in `logs/`, one file per distinct content. `AGENTGRAPH_CHECK_LOGS` keeps `all` (default), only `failed`, or `off`. `agi prune-logs --data <dir>` counts logs no check record names, and `--apply` deletes them; run it while nothing is driven. <!-- code: src/store.ts#checkLogs src/types.ts#Log src/store.ts#pruneLogs -->

## Checkouts

A run works in a checkout, a worktree of the tracker's `origin.git` in a local instance, or of `mirror.git` in the data folder of a GitHub instance. Its admin dir stays in that repo and its files in `cache/work/`; neither is in your repo. When the engine is done with it, it saves the files at `refs/agentgraph/runs/<run id>` for resuming and removes it. The first time it works, it keeps the graph folder, without `node_modules`, as a tree at `refs/agentgraph/graphs/<tree>` and records it as the run's `graphTree`, which never changes after; a run that cannot keep it fails like any other checkout error. <!-- code: src/git.ts#ensureGraphRef --> After every attempt, failed or empty ones too, it also commits the files at `refs/agentgraph/attempts/<run id>/<n>`, so a retry never overwrites an earlier try. On startup, the engine saves checkouts left by dead engine processes: it commits each at `refs/agentgraph/reaped/<checkout id>` and only then removes it with its index, news and scratch dirs. A sweep that repeats keeps the first commit. One it cannot save stays in `cache/work/` with a warning, and the sweep skips a checkout whose engine already failed to save it. <!-- code: src/mirror.ts#makeSandbox src/run/drive.ts#runWorkflow src/git.ts#commitCheckout src/git.ts#commitCheckoutOnce src/env.ts#findDeadCheckouts src/env.ts#removeCheckout -->

A run records the resolved `checkout.branch` and `checkout.base` when it creates its checkout. Its pull request is the one on that branch, and a `conflict` run it starts gets the same record. A fresh branch after a closed pull request is recorded the same way, so cleanup matches both the old and the new branch exactly. One cleanup sweep per tracker pass lists local agent branches and matches those records. With a mirror of a remote origin, only branches a checkout uses count, since each fetch restores the rest. A live run or pending end check keeps its branch; a run with no checkout record protects only branches matching its issue or workflow template. Cleanup reuses merged pull request state or reads one bounded page for the remaining branch per pass, falling back to the recorded base. Older runs without a checkout record require a merged PR head that exactly equals the local branch tip. Removed branches cause no tracker lookups. Run records, traces, results, attempt refs and shared caches stay; deleting a checkout removes its own build folders and symlinks without following their targets. Normal session cleanup already removes detached and temporary plain checkouts. <!-- code: src/types.ts#Run src/run/drive.ts#runWorkflow src/git.ts#readBranches src/mirror.ts#makeSandbox src/run/trigger.ts#scanIssuesAndRunningRuns src/tracker.ts#matches src/github.ts#githubTracker -->

Cleanup only removes worktrees under the engine's checkout root; any other worktree keeps its branch. Cleanup validates the checkout's regular `.git` file against its admin directory under the mirror and the admin directory's backlink and common directory. Symbolic branch refs, missing or redirected metadata, worktree config files, symlinked paths and submodule checkouts are skipped with a log. Ref deletion never follows symbolic refs. Status reads the trusted admin directory and index, with hooks and fsmonitor off, system attributes disabled and every configured clean/process filter disabled. Dirty files, assume-unchanged or skip-worktree flags, and commits outside the merged head and base keep the branch. Removal uses the same trusted Git settings without forcing, so Git refuses edits made after inspection. Ignored dependencies and build folders go with the checkout; an untracked `node_modules` symlink is unlinked first and its target stays. <!-- code: src/disk.ts#removeBranch src/git.ts#hostGit src/git.ts#readWorktreeAdmin -->

Cleanup deletes ignored files in a landed checkout too, so nothing worth keeping should live there. A commit made in a checkout during cleanup can be lost. <!-- code: src/disk.ts#removeBranch -->
