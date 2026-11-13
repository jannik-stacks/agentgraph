# Runs and data

## The data folder

`--data` selects the data root, falling back to `AGENTGRAPH_DATA`, then `~/.agentgraph`. Instance names default to checkout basenames; `--instance` overrides.

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
    homes/<id>/
    logs/<sha256>.gz
    .locks/
    cache/                 graphs/, work/, index/, news/, scratch/, sync/
```

Keep data outside the repo. Update `checkout` when moving a checkout. Local trackers require `tracker/origin.git`. Homes support resumes and forks; caches can be rebuilt. <!-- code: src/instance.ts#readInstance --> <!-- code: src/disk.ts#readEnvRefs src/disk.ts#writeEnvRefs src/mirror.ts#makeSandbox src/services.ts#hostSettings src/env.ts#getCachePath src/env.ts#getCheckoutPaths --> <!-- code: src/instance.ts#ensureInstance -->

`AGENTGRAPH_COMPRESS_DAYS` sets the idle days before ended runs' traces and checks compress: 14 by default, 0 to disable. Readers handle compression; appending unpacks first. <!-- code: src/store.ts#writeIdleRunsCompressed src/store.ts#readRecord -->

## Backup and restore

Stop drives and loops before backup. Include harness SQLite `-wal` files. Caches, Docker images and dependency volumes can be rebuilt.

```sh
tar -czf left-pad.tgz -C ~/.agentgraph --exclude left-pad/data/cache left-pad
```

Restore under the data root; preserve checkout paths or update `instance.yaml`. <!-- code: src/mirror.ts#makeSandbox src/instance.ts#ensureGraph -->

## instance.yaml

The first command creates this file. Unknown fields fail. `checkout`, `graph` and `env` paths resolve against the instance folder. See [selection and precedence](local.md#named-instances-and-settings).

| Field | Default; purpose |
| --- | --- |
| `repo` | Empty; tracker repository |
| `checkout` | Checkout path; repository for base sync and branch exports |
| `graph` | Checkout `.agentgraph/`; graph folder |
| `env` | None; env file |
| `loop` | `false`; outside-repo loop inclusion without `--instance` |
| `trust` | Instance owner; trusted logins |
| `image` | Graph image; override |
| `limits.parallel` | Graph limit; concurrent drives |
| `base` | First checked-out branch; fast-forward target |
| `owner` | First command's `git config user.name`, else OS user; local author and trusted login |
| `tracker` | `folder`; built-in or graph plugin; stores files in `tracker/`; paths refused |
| `runner` | `local`; built-in or host graph plugin |
| `provider` | None; saved provider |
| `exported` | None; last exported refs |
| `readonly` | Off; `true` prevents repo writes; `--read-only` sets it |

<!-- code: src/instance.ts#Instance src/settings.ts#InstanceFile -->

## The tracker folder

Issues have `<n>/issue.md`, `events.jsonl` and reactions; pull requests have `pull.json` and `diff.patch`. Branches live in `origin.git`; [push restrictions](proposals.md#pushes) apply. Graph `status` renames or disables issue parent folders. Open, closed and merged states remain in frontmatter.

Manual `labels` edits act as the issue author; trusted authors can trigger work or set `agent:` limits. `labels.json` tracks prior labels. Issues filed by the engine emit no label events; its label edits are attributed to it. <!-- code: src/tracker.ts#folderTracker -->

Create `issue.md` under an unused number or use `agi start`. A trusted author and trigger label start work next pass.

<!-- code: src/tracker.ts#folderTracker --> <!-- code: src/tracker.ts#findIssueDir src/tracker.ts#runLocked --> <!-- code: src/tracker.ts#writeIssueFile -->

## run.json

Initial saves hold run locks. Readers validate runs, traces and checks against schemas. Errors name files and lines; run lists skip invalid runs with reasons. Incomplete final lines are skipped and reported. <!-- code: src/store.ts#parseJsonlRows src/store.ts#readRunSync src/read.ts#parseJson -->

| Field | Meaning |
| --- | --- |
| `id`, `workflow`, `issue` | Identity; imports lack issues |
| `title`, `body` | Last-seen issue text |
| `step`, `status` | Current state |
| `tries`, `rounds` | Attempts, returns per step |
| `sessions`, `judges` | Kept sessions for steps and agent judges, respectively |
| `feedback`, `reason` | Context for retries or retros; reason for waiting or stopping |
| `waiting` | `on`: `run` with `id`, `limits` with `why`, or `engine` with `error`; supplies shown reason |
| `reported` | Carried step reports |
| `restarted` | Human restart |
| `retried` | Failure retry used; next failure waits |
| `limits` | `minutes`, `usd-per-run`, source labels; `timeout` after deadline |
| `answers` | Human answers with their questions |
| `said`, `unshown` | Where people last spoke; status not yet shown |
| `seen`, `eyes` | Last event intake; eyes reaction removed on reply |
| `base`, `onto` | Stacked parent's pull request; destination after a conflicted follow |
| `moved` | Catch-up starting commit and target base |
| `blocked` | Base, head and graph at failed catch-up; changes allow retry |
| `checkout` | Branch and original base |
| `graph`, `by` | Last-checked graph; dispatching run |
| `graphTree` | Immutable starting tree at `refs/agentgraph/graphs/<tree>` |
| `versions` | Immutable `engine` version from `git describe` or the package; `config` hash of `AGENTGRAPH_CONFIG`; Docker `image` ID; installed `harnesses` versions (`unknown` if absent). Box and plugin runners omit image and harness versions |
| `started`, `ended` | Times |
| `startCommit` | Measurement base |
| `meta` | Public JSON keyed by owner, including provenance |
| `owed` | Pending [end checks](checks.md#end-checks) |

<!-- code: src/types.ts#Run src/git.ts#readEngineVersions --> <!-- code: src/run/start.ts#startRun --> <!-- code: src/run/start.ts#startProposedRun -->

## Imported runs

[CLI](cli.md) `import` saves independent ended runs for `check --runs`. Commits use their parent as base; patches use `--from`, else `HEAD`. Optional issue text and `--meta` supply context. Imports use workflow `import`, with no issue or session trace; trace checks are n/a. Results, studio and checks include imports; loops and issue commands exclude them. <!-- code: src/instance.ts#writeImportedRun --> <!-- code: src/store.ts#fileStore src/graph.ts#isOnIssue -->

## Metadata

Run and result `meta` holds public JSON keyed by owner. Owners decode schemas. Immutable `meta.engine.origin` stores `plugin`, `version`, `job` and `input`; `meta.engine.continued` stores the latest accepted input.

Limits are 8 KiB per owner, 32 KiB total and 32 containers deep. Invalid or oversized JSON fails. Studio and traces expose metadata. Validation does not detect secrets; owner names grant no permissions. <!-- code: src/meta.ts#PluginMetadata src/meta.ts#getRunOrigin src/store.ts#fileStore -->

`start({ graph, issue, data, meta })` and `instruct(graph, instruction, meta)` attach metadata before saving. Only accepted inputs update continuation. <!-- code: src/main.ts#start src/run/trigger.ts#instruct src/run/trigger.ts#tick src/meta.ts#makeContinuedMeta -->

## Run labels

Append-only `labels.jsonl` stores `key=value` without affecting workflows. Keys allow lowercase letters, digits and hyphens, up to 32 characters. Values allow one line, up to 128 characters. Writes hold locks. Truncated final lines count as skips; other malformed lines fail. <!-- code: src/owner.ts#waitForLock --> <!-- code: src/store.ts#readJsonlRows src/store.ts#appendJsonlRows -->

Readers derive `engine`, `image`, `config` and `harnesses` labels from `versions`; explicit labels override them. Studio filters and result groups use labels. See [CLI](cli.md) `label` and `--run-label`. <!-- code: src/labels.ts#makeVersionLabels bin/results.ts --> <!-- code: src/labels.ts#writeRunLabels src/main.ts#start -->

## The trace

`trace.jsonl` entries carry `at`, `step` and an event kind. Entries from one session share a `key`.

| Kind | Contents |
| --- | --- |
| `prompt` | Harness, model, prompts and tools |
| `event` | Start with provider and model, text, tool calls with `ms`, usage and end |
| `session` | End reason, resume status, dropped-resume reason, cost and `used` |
| `setup` | `ms`, `exit` and `used` |
| `env`, `cache` | Environment and cached files |
| `applied` | Proposal with URL or failure reason |
| `outcome` | Pass, failure, back, ask, answer or stop; next state |
| `saved` | Changes; removals in `cleared` |
| `spoken` | Command or tracker event and its source |
| `inputs` | When input recording began |
| `told` | Forwarded text; `by` names the sending run or `cli` |

After `inputs`, `spoken` records each tracker event once per revision, with its `id` and `bot` flag. <!-- code: src/run/hear.ts#writeHeardEvents src/run/hear.ts#getEventKey src/run/trigger.ts#tick -->

Resumed sessions count only new usage and cost. The engine saves cumulative harness totals and subtracts the previous total. See [pricing](sandbox.md#settings). `used` reports peak memory, CPU time and OOM status when available. <!-- code: src/types.ts#Trace src/store.ts#fileStore --> <!-- code: src/types.ts#SessionEvent src/harnesses.ts#priced src/harnesses.ts#subtractUsage harnesses/codex.ts#makeCodexHarness harnesses/claude.ts#claude harnesses/pi.ts#pi --> <!-- code: src/docker.ts#dockerArgs src/types.ts#Exit src/remote.ts#makeBoxRunner studio/src/runs/rows.tsx -->

## The check record

`checks.jsonl` records version, result, findings, `value` or `share`, `empty` and n/a flags, cost, and optional exit, resource use and output log. `later` marks `check --runs` results. Versions hash the check, judge, harness, model and graph scripts. Session and check costs stay separate; run spend includes both. <!-- code: src/run/settle.ts#readRunSpend src/trace.ts#getRunSpend --> See [result selection](checks.md#the-results-tab). <!-- code: src/types.ts#CheckEntry src/store.ts#fileStore --> <!-- code: src/folder.ts#loadGraph src/trace.ts#findLatestChecks -->

## Run links

Tracker posts carry a hidden run marker and a visible ⁂ on its own line after the text. `AGENTGRAPH_STUDIO_URL` links it to the trace entry. `/<instance>/runs?gh=<link or comment id>` finds the run. <!-- code: src/tracker.ts#formatBodyWithRunLink src/event.ts#formatRunMark src/store.ts#locate src/store.ts#Located src/main.ts#readInstanceEnv -->

Operation keys prevent duplicate posts after interruption. <!-- code: src/run/settle.ts#findAppliedBefore -->

## Check logs

Full check output is gzipped by content in `logs/`. `AGENTGRAPH_CHECK_LOGS` selects `all` (default), `failed` or `off`. Stop drives before `agi prune-logs --data <dir>`; it reports unreferenced logs. `--apply` deletes them. <!-- code: src/store.ts#checkLogs src/types.ts#Log src/store.ts#pruneLogs -->

## Checkouts

Worktrees in `cache/work/` use the local tracker's `origin.git` or hosted tracker's `mirror.git`. Refs retain run files at `refs/agentgraph/runs/<id>`, every attempt including failures, and the starting `graphTree`. <!-- code: src/types.ts#Checkout --> <!-- code: src/git.ts#ensureGraphRef --> <!-- code: src/mirror.ts#makeSandbox src/run/drive.ts#runWorkflow src/git.ts#commitCheckout src/git.ts#commitCheckoutOnce src/env.ts#findDeadCheckouts src/env.ts#removeCheckout -->

Startup saves dead owners' checkouts at `refs/agentgraph/reaped/<id>` before removal. Failed saves warn and retain checkouts. Cleanup uses recorded branches and bases. Live runs, pending checks, dirty files, unmerged commits and worktrees outside the engine root retain branches. Run data and attempt refs remain. <!-- code: src/types.ts#Run src/run/drive.ts#runWorkflow src/git.ts#readBranches src/mirror.ts#makeSandbox src/run/trigger.ts#scanIssuesAndRunningRuns src/tracker.ts#matches src/github.ts#githubTracker -->

Cleanup skips unsafe or redirected worktree metadata with reasons. It never removes symlink targets. <!-- code: src/disk.ts#removeBranch src/git.ts#hostGit src/git.ts#readWorktreeAdmin -->

Cleanup removes ignored files with landed checkouts. Keep no manual work there; concurrent edits can be lost. <!-- code: src/disk.ts#removeBranch -->
