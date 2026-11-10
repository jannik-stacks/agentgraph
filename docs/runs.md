# Runs and data

A run is one workflow on one issue. Its status is `running`, `waiting` (a question, tries or rounds used up, or an engine error), `done` or `stopped` (a stop, a closed issue, a removed trigger label or the spend limit).

## The data folder

Each repo gets an instance under the data root. `--data` selects that root; runs live in `<root>/<name>/data`.

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

Keep data outside the repository. An instance name binds to one checkout; edit `checkout` in its record when moving it. A local tracker requires `tracker/origin.git`.

Ended runs idle for `AGENTGRAPH_COMPRESS_DAYS` (14) days have their traces and checks compressed to `.zst`. Readers handle either form; appending unpacks first. Check logs are gzipped. <!-- code: src/instance.ts#readInstance --> <!-- code: src/disk.ts#readEnvRefs src/disk.ts#writeEnvRefs src/mirror.ts#makeSandbox src/services.ts#hostSettings src/env.ts#getCachePath src/env.ts#getCheckoutPaths --> <!-- code: src/instance.ts#ensureInstance --> <!-- code: src/store.ts#writeIdleRunsCompressed src/store.ts#readRecord -->

## Backup and restore

Back up the instance folder with no drive or loop running, including harness SQLite `-wal` files. Cache contents, Docker images and dependency volumes can be rebuilt:

```sh
tar -czf left-pad.tgz -C ~/.agentgraph --exclude left-pad/data/cache left-pad
```

Unpack under the data root and keep the checkout at its recorded path, or update `instance.yaml`. <!-- code: src/mirror.ts#makeSandbox src/instance.ts#ensureGraph -->

## instance.yaml

Written by the first command in a repo. Unknown fields fail. `checkout`, `graph` and `env` paths resolve against the instance folder.

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
| `readonly`        | off                                                            | `true` writes nothing to the repo; `--read-only` sets it                                                                                                                                          | <!-- code: src/instance.ts#Instance src/settings.ts#InstanceFile --> |

## The tracker folder

The folder tracker keeps each issue in `<n>/issue.md`, with `events.jsonl` and reactions. `pull.json` and `diff.patch` describe a pull request; `origin.git` holds branches. [Push restrictions](proposals.md#pushes) still apply.

Status determines the issue's parent folder, such as `working/14/` or `needs-review/15/`; the graph's `status` map can rename or disable these folders. Open, closed and merged states stay in issue frontmatter.

Write `issue.md` under an unused number to add an issue, or use `agi start`. A trusted author and configured trigger label start work on the next pass. For example:

```md
---
title: Reject a negative count
author: morgan
labels: [agent:ready]
---

count(-1) should throw.
```

<!-- code: src/tracker.ts#folderTracker --> <!-- code: src/tracker.ts#findIssueDir src/tracker.ts#runLocked --> <!-- code: src/tracker.ts#writeIssueFile -->

## run.json

The store saves each run under an id lock before showing its initial status. The record includes:

| Field                     | Meaning                                                                                                                                                                                                                                                                                                                                                                                                     |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `id`, `workflow`, `issue` | The run, its workflow and its issue; an [imported run](#imported-runs) has no issue                                                                                                                                                                                                                                                                                                                         |
| `title`, `body`           | The issue text as the run last saw it                                                                                                                                                                                                                                                                                                                                                                       |
| `step`, `status`          | Current step and status                                                                                                                                                                                                                                                                                                                                                                                     |
| `tries`, `rounds`         | Attempts at this step, and returns per step                                                                                                                                                                                                                                                                                                                                                                 |
| `sessions`                | The kept session of each step                                                                                                                                                                                                                                                                                                                                                                               |
| `judges`                  | The kept session of each check an agent judges |
| `feedback`, `reason`      | Context for the next try or a [retro](workflows.md#retros), and why the run waits or stopped                                                                                                                                                                                                                                                                                                                |
| `reported`                | The last report of each step that carries its report to the next step |
| `restarted`               | A person restarted the run |
| `retried`                 | The run already asked once after a failure; the next failure leaves it waiting |
| `answers`                 | Human answers, each with its question                                                                                                                                                                                                                                                                                                                                                                       |
| `said`, `unshown`         | Where people last spoke, and a status the tracker has yet to show                                                                                                                                                                                                                                                                                                                                           |
| `seen`                    | When the run last took in events on its issue |
| `eyes`                    | The eyes reaction the run left on a comment, removed once it replies |
| `base`, `onto`            | The stacked parent's pull request, and where a conflicted follow lands                                                                                                                                                                                                                                                                                                                                      |
| `moved`                   | A catch-up onto a moved base: the commit the branch started from and the base it moves onto |
| `blocked`                 | The base, head and graph a failed catch-up stopped at; it tries again once one changes |
| `checkout`                | The run's branch and the base it was checked out from |
| `graph`, `by`             | Graph version last checked, and the run that dispatched this one                                                                                                                                                                                                                                                                                                                                            |
| `graphTree`               | The git tree of the graph folder the run started under, kept at `refs/agentgraph/graphs/<tree>`; set once                                                                                                                                                                                                                                                                                                   |
| `versions`                | What produced the run, set once with `graphTree`: `engine`, the `git describe` of the engine checkout or else its package version; `config`, a hash of the `AGENTGRAPH_CONFIG` file when one is set; `image`, the Docker ID; and `harnesses`, the version of each graph agent's harness in that image, `unknown` when the image lacks its package. A box or plugin runner records no image and no harnesses |
| `started`, `ended`        | When the run started and ended                                                                                                                                                                                                                                                                                                                                                                              |
| `startCommit`             | The commit the run's change is measured from                                                                                                                                                                                                                                                                                                                                                                |
| `meta`                    | Public JSON keyed by owner, including engine provenance                                                                                                                                                                                                                                                                                                                                                     |
| `owed`                    | [End checks](checks.md#end-checks) the ended run still has to run                                                                                                                                                                                                                                                                                                                                           | <!-- code: src/types.ts#Run src/git.ts#readEngineVersions --> <!-- code: src/run/start.ts#startRun --> <!-- code: src/run/start.ts#startProposedRun -->

## Imported runs

`agi import <commit>|<patch> [<issue file>]` saves an external change as an ended run for `check --runs`. Commits are measured from their parent; patches apply to `--from`, else `HEAD`. The optional issue file supplies title and body; `--meta` adds origin input.

Imports have workflow `import`, no issue and no session trace, so trace checks are n/a. Each import creates a separate run. Results, the studio and later checks see it; issue-following commands and the loop do not. <!-- code: src/instance.ts#writeImportedRun --> <!-- code: src/store.ts#fileStore src/graph.ts#isOnIssue -->

## Metadata

Run and result-row `meta` holds public JSON keyed by owner. `meta.engine.origin` stores immutable `plugin`, `version`, `job` and `input`; `meta.engine.continued` records the latest accepted caller input. Owners decode their own schemas.

Limits are 8 KiB per owner, 32 KiB total and 32 nested containers. Validation rejects unsupported or oversized JSON, but does not detect secrets. Metadata appears in studio and traces; owner names do not grant permissions.

Programmatic `start({ graph, issue, data, meta })` and `instruct(graph, instruction, meta)` attach metadata before saving. Accepted inputs update continuation; polls and rejected inputs do not. <!-- code: src/meta.ts#PluginMetadata src/meta.ts#getRunOrigin src/store.ts#fileStore --> <!-- code: src/main.ts#start src/run/trigger.ts#instruct src/run/trigger.ts#tick src/meta.ts#makeContinuedMeta -->

## Run labels

Labels are `key=value` pairs in append-only `labels.jsonl`; they do not change workflow behavior. Keys use lowercase letters, digits and hyphens, up to 32 characters; values are single lines up to 128 characters. Writes are locked. A truncated final line is visibly counted as skipped; other malformed lines fail.

Readers derive `engine`, `image`, `config` and `harnesses` from `versions`; explicit labels override these. `agi start --run-label k=v` labels runs at creation. `agi label <run id> k=v old-` sets `k` and removes `old`. Use `agi label <store>/<run> k=v old-` for a run in any store, including bench data. Studio filters and result groups use labels. <!-- code: src/owner.ts#waitForLock --> <!-- code: src/store.ts#readJsonlRows src/store.ts#appendJsonlRows --> <!-- code: src/labels.ts#makeVersionLabels bin/results.ts --> <!-- code: src/labels.ts#writeRunLabels src/main.ts#start -->

## The trace

Each `trace.jsonl` entry has `at`, `step` and an event kind; session entries share a `key`.

| Kind           | Contents                                                                           |
| -------------- | ---------------------------------------------------------------------------------- |
| `prompt`       | Harness, model, system prompt, prompt and tools                                    |
| `event`        | Harness start (with provider and model), text, tool calls with `ms`, usage and end |
| `session`      | End reason, whether it resumed, why a resume was dropped, cost, and `used`         |
| `setup`        | `ms`, `exit` and `used` of setup in a checkout                                     |
| `env`, `cache` | The [environment](sandbox.md#environments) a checkout used, and files it cached    |
| `applied`      | A proposal with its URL or why it failed                                           |
| `outcome`      | Pass, failure, back, ask, answer or stop, and the next state                       |
| `saved`        | Changed state fields; `cleared` lists removed ones                                 |
| `spoken`       | A CLI command or a tracker event the run heard, where it came from                 |
| `inputs`       | Since when the run records what it hears                                           |
| `told`         | Forwarded text, with the sender in `by`: a router run id or `cli`                  |

Runs record each tracker event they hear, once per revision, as a `spoken` line with its tracker `id` and a `bot` flag, after an `inputs` line that says since when. <!-- code: src/run/hear.ts#writeHeardEvents src/run/hear.ts#getEventKey src/run/trigger.ts#tick -->

Usage events may name the model that answered; pricing uses it before the requested alias. `used` holds reported container peak memory, CPU time and OOM status, when available. <!-- code: src/types.ts#Trace src/store.ts#fileStore --> <!-- code: src/types.ts#SessionEvent src/harnesses.ts#priced harnesses/claude.ts#claude harnesses/pi.ts#pi --> <!-- code: src/docker.ts#dockerArgs src/types.ts#Exit src/remote.ts#makeBoxRunner studio/src/runs/rows.tsx -->

## The check record

Each `checks.jsonl` entry records a check version, result, findings, value or share, empty/n/a flags, cost and optional script exit, resource use and full-output log. `later` marks results from `check --runs`.

The version hashes the check, judge, harness, model and graph scripts. Readers prefer the newest result under that version, else mark an older result. Session and checking costs remain separate. <!-- code: src/types.ts#CheckEntry src/store.ts#fileStore --> <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Run links

Tracker posts carry a hidden run marker and a visible ⁂. Set `AGENTGRAPH_STUDIO_URL` to link it to the run's trace entry. The studio's `/<instance>/runs?gh=<link or comment id>` finds the run behind a post.

Operation keys prevent duplicate posts after interruption. <!-- code: src/tracker.ts#formatBodyWithRunLink src/event.ts#formatRunMark src/store.ts#locate src/store.ts#Located src/main.ts#readInstanceEnv --> <!-- code: src/run/settle.ts#findAppliedBefore -->

## Check logs

Full check output is gzipped by content under `logs/`. `AGENTGRAPH_CHECK_LOGS` selects `all` (default), `failed` or `off`. With no drive running, `agi prune-logs --data <dir>` reports unreferenced logs; `--apply` deletes them. <!-- code: src/store.ts#checkLogs src/types.ts#Log src/store.ts#pruneLogs -->

## Checkouts

Runs use worktrees under `cache/work/`, backed by the tracker's `origin.git` or the hosted tracker's `mirror.git`. Kept files live at `refs/agentgraph/runs/<id>`; each attempt also has a ref, including failed attempts. The starting graph tree is retained and recorded as `graphTree`.

Startup saves dead owners' checkouts at `refs/agentgraph/reaped/<id>` before removing them. A checkout that cannot be saved stays with a warning.

Cleanup uses recorded branches and bases. Live runs, pending checks, dirty files, unmerged commits and worktrees outside the engine root keep their branches. Unsafe or redirected worktree metadata is skipped with a reason; symlink targets are never removed. Run records, traces, checks and attempt refs remain.

Cleanup removes ignored build files with a landed checkout. Keep no manual work there; concurrent edits can be lost. <!-- code: src/git.ts#ensureGraphRef --> <!-- code: src/mirror.ts#makeSandbox src/run/drive.ts#runWorkflow src/git.ts#commitCheckout src/git.ts#commitCheckoutOnce src/env.ts#findDeadCheckouts src/env.ts#removeCheckout --> <!-- code: src/types.ts#Run src/run/drive.ts#runWorkflow src/git.ts#readBranches src/mirror.ts#makeSandbox src/run/trigger.ts#scanIssuesAndRunningRuns src/tracker.ts#matches src/github.ts#githubTracker --> <!-- code: src/disk.ts#removeBranch src/git.ts#hostGit src/git.ts#readWorktreeAdmin --> <!-- code: src/disk.ts#removeBranch -->
