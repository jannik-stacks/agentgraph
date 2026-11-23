# Runs and data

An [instance](index.md#terms) keeps its settings, local tracker files and run records together. Start here to back it up or inspect what happened during a run. <!-- code: src/instance.ts#readInstance src/store.ts#fileStore -->

## The data folder

`--data` selects the data root, falling back to `AGENTGRAPH_DATA`, then `~/.agentgraph`. The instance name defaults to the name of the checkout folder. Choose a different name with `--instance`. <!-- code: src/services.ts#readHostSettings src/instance.ts#ensureInstance -->

```text
<root>/<name>/
  instance.yaml
  tracker/                 issues, timelines, origin.git
  data/
    <id>/run.json
    <id>/checks.jsonl       or .zst
    <id>/trace.jsonl        or .zst
    <id>/labels.jsonl
    mirror.git
    .envs/refs.jsonl
    files/<sha256>
    homes/<session-home-id>/
    logs/<sha256>.gz
    .locks/
    cache/                 graphs/, work/, index/, news/, scratch/, sync/
```

Keep the data root outside the repository. The local tracker keeps branches in `tracker/origin.git`. A hosted tracker uses a mirror, a bare git repository at `data/mirror.git`. Each new session home has a random ID. A resumed session reuses its home and a fork gets a new one. <!-- code: src/instance.ts#readInstance src/instance.ts#ensureInstance src/harnesses.ts#harnessSession src/disk.ts#readEnvRefs src/mirror.ts#makeSandbox src/env.ts#getCheckoutPaths -->

`AGENTGRAPH_COMPRESS_DAYS` sets how many days an ended run must be idle before the engine compresses its trace and checks. It defaults to 14 days. Set it to 0 to disable compression. Readers open either format, and writers unpack a record before appending. <!-- code: src/store.ts#writeIdleRunsCompressed src/store.ts#readRecord src/store.ts#appendJsonlRows -->

## Backup and restore

Stop active runs and loops before making a backup. Include the session homes and any SQLite `-wal` files they contain. You can rebuild caches, Docker images and dependency volumes. <!-- code: src/harnesses.ts#harnessSession src/mirror.ts#makeSandbox src/docker.ts#dockerRunner -->

```sh
tar -czf mono.tgz -C ~/.agentgraph --exclude mono/data/cache mono
```

Restore the archive under the data root. If the checkout moved, update `checkout` in `instance.yaml`. <!-- code: src/mirror.ts#makeSandbox src/instance.ts#ensureGraph -->

## instance.yaml

The CLI writes `instance.yaml` when it creates an instance. It rejects unknown fields and resolves relative `checkout`, `graph` and `env` paths against the instance folder. See [selection and precedence](local.md#named-instances-and-settings). <!-- code: src/instance.ts#readInstance src/instance.ts#ensureInstance -->

| Field | Meaning and default |
| --- | --- |
| `repo` | Repository name for the tracker, such as `acme/mono`. The default is an empty string. |
| `checkout` | Repository path for syncing the base branch and exporting branches. |
| `graph` | Graph folder. The default is the checkout's `.agentgraph/`. |
| `env` | Optional path to an environment file. |
| `loop` | Set this to `true` to include the instance when starting a loop outside a repository without naming instances. The default is `false`. |
| `trust` | List of trusted logins. It defaults to the instance owner. |
| `image` | Sandbox image. It defaults to the graph's image. |
| `limits.parallel` | Maximum number of concurrent sandbox commands. It defaults to the graph's limit. |
| `base` | Branch the engine can fast-forward. It defaults to the current branch when the instance is created. |
| `owner` | Login used for local authorship. It defaults to the checkout’s git user name, or the OS user if unset. |
| `tracker` | Tracker plugin name. The default, `folder`, keeps issues in `tracker/`. Instance settings accept a name only. |
| `runner` | Runner plugin name. The default is `local`. |
| `provider` | Optional saved choice of model provider. |
| `exported` | Last exported commit for each branch, initially empty. |
| `readonly` | Whether the instance prevents repository writes. The default is off. See [CLI flags](cli.md#flags). |

<!-- code: src/instance.ts#Instance src/instance.ts#ensureInstance src/settings.ts#InstanceFile src/settings.ts#getSettings src/services.ts#pickRunner bin/run.ts -->

## The tracker folder

To file an issue by hand, choose an unused issue number and create `tracker/<number>/issue.md`. Put the title, author login and labels in YAML frontmatter, and the request in the Markdown body. A trigger label from a trusted author can start work on the next pass. You can also file the issue with `agi start`. <!-- code: src/tracker.ts#folderTracker src/tracker.ts#parseIssueFile src/run/trigger.ts#tick bin/run.ts -->

The folder tracker stores the timeline in `events.jsonl` and records reactions alongside it. A pull request also has `pull.json` and `diff.patch`. Its branches live in `origin.git` and follow the [push restrictions](proposals.md#pushes). <!-- code: src/tracker.ts#folderTracker -->

When the displayed status changes, the tracker moves the whole numbered issue folder under a folder named for the new status. A graph may map a status to a different folder name. If the mapping omits that status, its issue folder moves to the tracker root. With `status: false` the engine skips these moves. The issue's open, closed or merged state stays in the frontmatter. <!-- code: src/tracker.ts#folderTracker src/tracker.ts#findIssueDir src/run/settle.ts#writeStatus -->

When you edit the frontmatter's `labels`, the tracker compares them with `labels.json` and attributes changes to the issue author. A trusted author's edits can trigger work or set `agent:` limits. Filing an issue through the engine emits no label events. Later engine label edits appear under its own login. <!-- code: src/tracker.ts#folderTracker -->

## run.json

The engine locks a run before its first save. Readers validate runs, traces and checks against schemas. They report malformed records with their file paths, and malformed JSON lines with line numbers. A run listing skips invalid runs and reports why. Readers report and skip an incomplete final line. <!-- code: src/store.ts#parseJsonlRows src/store.ts#readRunSync src/read.ts#parseJson -->

| Field | Meaning |
| --- | --- |
| `id`, `workflow`, `issue` | Run ID, workflow name and issue number. Imported runs omit the issue number. |
| `title`, `body` | Last-seen issue text |
| `step`, `status` | Current state |
| `tries`, `rounds` | Attempts, returns per step |
| `sessions`, `judges` | Kept sessions for steps and agent judges, respectively |
| `feedback`, `reason` | Text for the next try or feedback workflow, and the reason the run waits or stops |
| `waiting` | Cause of the wait. Its `on` field is `run` with a child `id`, `limits` with `why`, or `engine` with an optional `error`. |
| `reported` | Carried step reports |
| `restarted` | Human restart |
| `retried` | Whether the run has used its immediate retry after an engine failure |
| `limits` | The time and spend limits, `minutes` and `usdPerRun`. Each stores `{ value, label? }`. A source `label` records its `name`, `actor` and `at`. A timeout sets `timeout`. Settings and issue labels spell the spend limit `usd-per-run`. |
| `answers` | Human answers with their questions |
| `said`, `unshown` | Threads where people last spoke, and whether a status update remains to be shown |
| `seen`, `eyes` | Last event time read, and the eyes reaction the engine can remove after replying to a comment it took |
| `base`, `onto` | Pull request on which this branch is based, and target commit for resolving a conflict |
| `moved` | Starting commit and destination when updating the branch to match a moved base (catch-up) |
| `blocked` | Base, head and graph at the last failed catch-up. A change allows another try. |
| `checkout` | Branch and original base |
| `graph`, `by` | Last graph checked during catch-up, and ID of the run that dispatched this one |
| `graphTree` | Immutable starting tree at `refs/agentgraph/graphs/<tree>` |
| `versions` | Versions recorded on first checkout. These include `engine` from `git describe` or the package and the `config` hash of `AGENTGRAPH_CONFIG` when available. Docker adds its `image` ID and `harnesses` versions (`unknown` if absent). |
| `started`, `ended` | Times |
| `startCommit` | Measurement base |
| `meta` | Public JSON keyed by owner, including provenance |
| `owed` | Pending [end checks](checks.md#end-checks) |

<!-- code: src/types.ts#RunFields src/types.ts#Limit src/git.ts#readEngineVersions src/run/follow.ts#runCatchUp src/run/settle.ts#writeEyes src/run/start.ts#startRun src/run/start.ts#startProposedRun -->

## Imported runs

`agi import` saves a commit or patch as an ended run for later checks. Use `--from` to choose the base. The default is the parent for a commit or `HEAD` for a patch. You can supply issue text and metadata with the [CLI](cli.md#verbs). The imported record uses the workflow `import` and has no issue number or session trace. Trace checks report n/a (not applicable) because that input is missing. The studio and later checks include imports. Loops and issue commands work only on runs with an issue. <!-- code: src/instance.ts#writeImportedRun src/store.ts#fileStore src/graph.ts#isOnIssue src/run/evaluate.ts#whyNotApplicable -->

## Metadata

Run and result `meta` holds public JSON keyed by owner. Each owner decodes its own data. Immutable `meta.engine.origin` stores `plugin`, `version`, `job` and `input`. The field `meta.engine.continued` stores the latest accepted input. <!-- code: src/meta.ts#getRunOrigin src/meta.ts#makeContinuedMeta -->

Limits are 8 KiB per owner, 32 KiB total and 32 containers deep. Invalid or oversized JSON fails. Studio and traces expose metadata. Use only public values. Validation checks structure and size, and owner names confer no permissions. <!-- code: src/meta.ts#PluginMetadata src/meta.ts#getRunOrigin src/store.ts#fileStore -->

`start({ graph, issue, data, meta })` and `instruct(graph, instruction, meta)` attach metadata before saving. Only accepted inputs update continuation. <!-- code: src/main.ts#start src/run/trigger.ts#instruct src/run/trigger.ts#tick src/meta.ts#makeContinuedMeta -->

## Run labels

Run labels describe a run without changing its workflow. The engine appends each label edit to `labels.jsonl`. Keys start with a lowercase letter and allow up to 32 lowercase letters, digits and hyphens. Values contain 1 to 128 characters on one line. Writes hold locks. Readers report and skip a truncated final line. Other malformed lines cause an error. <!-- code: src/labels.ts#LabelRecord src/labels.ts#writeRunLabels src/store.ts#readJsonlRows src/store.ts#appendJsonlRows -->

Readers derive `engine`, `image`, `config` and `harnesses` labels from `versions`. Explicit labels override them. Studio filters and result groups use labels. See [CLI](cli.md) `label` and `--run-label`. <!-- code: src/labels.ts#makeVersionLabels bin/results.ts src/labels.ts#writeRunLabels src/main.ts#start -->

## The trace

`trace.jsonl` entries carry `at`, `step` and a key that identifies what happened. Entries from one session share a `key`. <!-- code: src/types.ts#Trace src/run/execute.ts#runSession -->

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, prompts and tools |
| `event` | Start with provider and model, text, tool calls with `ms`, usage and end |
| `session` | End reason, resume status, dropped-resume reason, cost and resource use in `used` |
| `setup` | `ms`, `exit` and resource use in `used` |
| `env`, `cache` | Environment and cached files |
| `applied` | Proposal with URL or failure reason |
| `outcome` | The result of the try or event and the resulting state |
| `saved` | Changes to the run and any fields removed in `cleared` |
| `spoken` | Command or tracker event and its source |
| `inputs` | When input recording began |
| `told` | Forwarded text and its source (a sending run ID or `cli`) |
| `heard` | What one [event hook](plugins.md#event-hooks) recorded about an event, including `plugin`, `does`, `why`, `usd` |

<!-- code: src/types.ts#Trace src/types.ts#SessionEvent src/run/hear.ts#readHeard -->

After `inputs`, `spoken` records each tracker event once per revision, with its `id` and `bot` flag. <!-- code: src/run/hear.ts#writeHeardEvents src/run/hear.ts#getEventKey src/run/trigger.ts#tick -->

Resumed sessions count only new usage and cost. The engine saves cumulative harness totals and subtracts the previous total. See [pricing](sandbox.md#settings). `used` reports peak memory, CPU time and whether the process ran out of memory when available. <!-- code: src/types.ts#Trace src/store.ts#fileStore src/types.ts#SessionEvent src/harnesses.ts#priced src/harnesses.ts#subtractUsage harnesses/codex.ts#makeCodexHarness harnesses/claude.ts#claude harnesses/pi.ts#pi src/docker.ts#dockerArgs src/types.ts#Exit src/remote.ts#makeBoxRunner studio/src/runs/rows.tsx -->

## The check record

Each line of `checks.jsonl` records one check's version, result, findings and cost. A check can return a structured `value` or a passing fraction (`share`). An `empty` result has no usable measurement. The `na` flag means the check does not apply to this run. Entries may also record an exit code, resource use and an output log. A `later` entry comes from `agi check --runs`. Versions hash the check, judge (the agent scoring it), harness, model and graph scripts. Run spend includes both session and check costs. See [result selection](checks.md#the-results-tab). <!-- code: src/types.ts#CheckEntry src/types.ts#CheckResult src/run/check.ts#runOneCheck src/run/evaluate.ts#runEndedChecks src/trace.ts#getRunSpend src/folder.ts#loadGraph -->

## Run links

Tracker posts carry a hidden run marker and a visible ⁂ on its own line after the text. `AGENTGRAPH_STUDIO_URL` links it to the trace entry. `/<instance>/runs?gh=<link or comment id>` finds the run. <!-- code: src/tracker.ts#formatBodyWithRunLink src/event.ts#formatRunMark src/store.ts#locate src/store.ts#Located src/main.ts#readInstanceEnv -->

Operation keys prevent duplicate posts after interruption. <!-- code: src/run/settle.ts#findAppliedBefore -->

## Check logs

The engine compresses check output with gzip and saves it under its content hash in `logs/`. `AGENTGRAPH_CHECK_LOGS` selects `all` (default), `failed` or `off`. Stop active runs before pruning logs. Use `agi prune-logs --data <dir>` to list unreferenced logs and add `--apply` to delete them. <!-- code: src/store.ts#checkLogs src/types.ts#Log src/store.ts#pruneLogs -->

## Checkouts

Worktrees in `cache/work/` use the local tracker's `origin.git` or hosted tracker's `mirror.git`. Refs retain run files at `refs/agentgraph/runs/<id>`, every attempt including failures, and the starting `graphTree`. <!-- code: src/types.ts#Checkout src/git.ts#ensureGraphRef src/mirror.ts#makeSandbox src/run/drive.ts#runWorkflow src/git.ts#commitCheckout src/git.ts#commitCheckoutOnce src/env.ts#findDeadCheckouts src/env.ts#removeCheckout -->

At startup the engine saves checkouts left by a dead process at `refs/agentgraph/reaped/<id>` before removing them. If the save fails, it warns and keeps the checkout. Cleanup uses the recorded branch and base. It keeps branches with live runs, pending checks, dirty files, unmerged commits or worktrees outside the engine root. Run data and attempt refs remain. <!-- code: src/types.ts#Run src/run/drive.ts#runWorkflow src/git.ts#readBranches src/mirror.ts#makeSandbox src/run/trigger.ts#scanIssuesAndRunningRuns src/tracker.ts#matches src/github.ts#githubTracker -->

Cleanup skips unsafe or redirected worktree metadata with reasons. It never removes symlink targets. <!-- code: src/disk.ts#removeBranch src/git.ts#hostGit src/git.ts#readWorktreeAdmin -->

Cleanup removes ignored files with landed checkouts. Keep manual work outside those checkouts so cleanup cannot discard it. <!-- code: src/disk.ts#removeBranch -->
