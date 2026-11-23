# Architecture

Follow an issue from its first tracker event to the files that let the engine resume it.
See [Types and schemas](types.md) for the data, [Code layout](layout.md) for file ownership and [Conventions](patterns.md) for changes.

```text
loop pass --> scan --> tick --> start or hear --> drive --> attempt
                        |                          ^           |
                        v                          |           v
                 follow or catch up              settle <--- checks
                                                   |
                                                   v
                                            wait, done or stop
```

A [run](index.md#terms) belongs to one issue. A pass can find many runs, and a run can span many passes.
The diagram follows one try. After settling it, the drive continues while the run is ready for another step. <!-- code: src/main.ts#start src/run/trigger.ts#tick src/run/drive.ts#runWorkflow -->

The CLI builds production layers for the tracker, store, sandbox and session. The engine uses those services to drive the run. See [Code layout](layout.md#layers-in-src) for their implementations. <!-- code: bin/run.ts src/services.ts#makeProductionLayers src/run/execute.ts#Services -->

## What is pure and what is effectful

The engine owns decisions about which actions are valid. Agents edit files, propose actions and supply judgments for checks that need them.
To change the meaning of an event or outcome, start with a function that accepts data and returns a decision. <!-- code: src/workflow.ts#transition src/run/attempt.ts#pickTryOutcome src/run/execute.ts#runJudge -->

For example, `tick` interprets tracker events and `runWorkflow` executes steps. Both call `transition` to calculate the next state before saving it. Transition tests pass values directly to the rule. Drive tests supply [test services](patterns.md#tests). <!-- code: src/run/trigger.ts#tick src/run/drive.ts#runWorkflow src/workflow.ts#transition tests/transition.test.ts tests/world.ts#services -->

## One pass

`start` chooses the entry point. A CLI `Instruction` goes to `instruct` for `say`, `dispatch`, `check` or `resume`.
A hosted event poll calls `scanTrackerEvents`. A full scan (`issue: 'all'`) calls `scanIssuesAndRunningRuns`. Work on one issue goes straight to `tick`. <!-- code: src/main.ts#start src/run/trigger.ts#instruct src/run/trigger.ts#Instruction src/run/trigger.ts#tick -->

The CLI's `loop` serves each checkout under a loop lock. In `serveLocked`, each full pass compresses idle records, loads the graph and scans.
A separate loop polls hosted events. See [loop timing and wakeups](local.md#the-loop). <!-- code: bin/run.ts#serveLocked src/owner.ts#createLoopLock src/store.ts#writeIdleRunsCompressed src/tracker.ts#waitForTrackerEdit src/services.ts#hostSettings -->

The full scan calls `tick` once for each issue it selects. It selects open issues in scope, issues with live runs or outstanding end checks, and issues whose settled runs can start a feedback workflow. It also picks up trusted agent requests since the newest run began, allowing for the debounce interval.
Each issue has a gate with one permit. Across issues, the scan admits up to `limits.parallel` at once. Afterward it asks the sandbox to clean up eligible landed branches once their runs and checks finish. <!-- code: src/run/trigger.ts#scanIssuesAndRunningRuns src/run/trigger.ts#readIssueScan src/mirror.ts#makeSandbox -->

The event scan starts from a cursor. It considers issues with trusted events and issues still due from an earlier pass. When a pull request receives an event, it also considers the issue whose run owns the pull request branch.
If another pass holds the issue's gate, the event scan leaves the issue due with its original cursor. This lets the next poll recover the events that pass missed. A trusted event younger than `issueDebounceMs` (30 seconds) defers starts and wakeups so a burst of edits can be read together.
The cursor advances to the newest event time, including events from untrusted actors. <!-- code: src/run/trigger.ts#scanTrackerEvents src/run/trigger.ts#issueDebounceMs src/run/trigger.ts#tick -->

`startLoopDrives` keeps active run ids, per-issue gates, due issues, the cursor and runs settled in the background.
`runPass` returns when the pass has decided which work to start. Drives it forked can continue after that point. <!-- code: src/run/trigger.ts#startLoopDrives src/run/trigger.ts#runPass -->

## Tick

`tick(graph, only?)` processes one issue when given a number. Otherwise it considers all issues. Its order matters when a reply, a branch move and a new request arrive together. <!-- code: src/run/trigger.ts#tick -->

1. Read the stored runs, open issues and events. The cursor is the earlier of the newest run's start time and the earliest live run's `seen` time (or its start time).
2. Match pull request branches to runs. An event on a matching pull request belongs to the run's issue. Keep its original issue number so replies and reactions land on the right thread.
3. Lock each candidate run and read beyond its cursor. `readHeard` asks eligible plugin hooks for a decision. `getEventOutcome` interprets the event using that decision or the workflow's mapping, with `pickCommandTarget` for commands. Among events with an outcome, `tick` selects a merge first, then a non-answer. If only answers remain, `fold` combines their text. Only a stop interrupts a running run here. At a human wait with an open pull request, an answer can open an aside, a side session that replies while the run waits.
4. Join children. When a child leaves the running state, turn its result into an answer for its waiting parent.
5. Retry parked runs. After an engine failure, `isEngineRetryDue` measures the [retry delay](workflows.md#engine-errors) from the run’s last move.
6. Select a workflow for remaining events. A label or column can trigger an issue workflow. An agent request selects a named workflow or the first comment workflow. Check trust, scope, timing and whether the event was already handled. `makeRunId` uses the workflow name, issue and event time so replaying that start produces the same id.
7. Start feedback workflows for newly settled work or fresh feedback on the issue.
8. Follow stacked branches and catch up eligible pull requests whose base or graph moved.
9. Drive the running runs whose dependencies allow them to proceed. Without a loop, wait for the drives. With a loop, fork them so the next pass can proceed. Then schedule any outstanding end checks.

<!-- code: src/run/trigger.ts#tick src/run/hear.ts#formatRunBranch src/tracker.ts#findBranchPull src/run/hear.ts#readHeard src/workflow.ts#getHeard src/workflow.ts#getEventOutcome src/workflow.ts#fold src/workflow.ts#pickCommandTarget src/run/follow.ts#runAside src/run/start.ts#formatSettled src/run/trigger.ts#isEngineRetryDue src/workflow.ts#isIssueTriggered src/run/start.ts#makeRunId src/run/hear.ts#findSettledRuns src/run/follow.ts#runFollow src/run/follow.ts#runCatchUp src/run/settle.ts#runEndChecks -->

The `/agent:restart` command stops the live run with `restarted: true`. The fresh start copies its answers and reported step outputs. <!-- code: src/run/trigger.ts#tick src/workflow.ts#getEventOutcome src/workflow.ts#transition -->

## Start

`begin` constructs the initial run. `startRun` locks its id and returns without starting work if the id is locked or already stored.
Otherwise it saves the record before invoking its caller's `ready` function. For a tracker start, this function records the triggering event, publishes the status and leaves the eyes reaction to acknowledge a comment. <!-- code: src/workflow.ts#begin src/run/start.ts#startRun src/run/trigger.ts#tick -->

`findUndispatchable` explains why a proposed start cannot proceed.
`startProposedRun` records the parent in `by` for a child started by a run proposal. A human dispatch uses `cli` as the dispatcher id. <!-- code: src/run/start.ts#findUndispatchable src/run/start.ts#startProposedRun src/run/trigger.ts#instruct -->

`createIssues` files the issues proposed by a try. Each part receives a parent and a size label.
As earlier parts acquire issue numbers, the engine resolves the positions in `stacks_on` and `depends_on` to those numbers. An XL part starts the filing workflow again when the new part is less than three levels deep. <!-- code: src/run/start.ts#createIssues -->

## Drive

`runWorkflow` locks the run and rereads it. A run that has already left the running state needs no drive.
The drive hears queued events before opening a checkout. It normally defers answers until the try ends, but cancel mode can take an answer immediately. <!-- code: src/run/drive.ts#runWorkflow -->

Before accepting more work, the drive reads the trusted `agent:minutes:<n>` and `agent:usd-per-run:<n>` labels and checks the run's accumulated spend.
The drive writes status, then chooses the workflow's branch. If the earlier pull request closed without merging, it finds a free suffix such as `-2` or `-3`. <!-- code: src/run/drive.ts#runWorkflow src/folder.ts#parseIssueLimits -->

The drive opens a checkout under a parallel slot, a place in the queue for sandbox work. It supplies the base, branch and the ref `refs/agentgraph/runs/<id>` that preserves the work.
On first use it saves the graph tree in `graphTree` and the engine, image and available harness versions in `versions`. It runs eligible graph setup and applies a pending base move before the first try. <!-- code: src/run/drive.ts#runWorkflow src/run/checkout.ts#runSetup src/run/follow.ts#moveCheckoutOnto src/git.ts#ensureGraphRef -->

For each try, the drive calls `runAttempt` and saves the tree to `refs/agentgraph/attempts/<id>/<n>`. A push refused because its branch moved reopens the checkout before trying again. Otherwise the drive settles the outcome.
The drive writes the outcome line, updates tracker status and saves the resulting run, in that order. It then hears queued answers.
Entering a human wait sets the status to waiting inside `begin` or `transition`, so the drive ends without opening a session for that step. <!-- code: src/run/drive.ts#runWorkflow src/git.ts#commitCheckout src/trace.ts#makeOutcomeLine src/run/settle.ts#writeStatus src/workflow.ts#entered -->

Sandbox, session and tracker failures reach the drive's `halt` handler. A human stop or rejected login stops the run. A timeout against a recorded limit sends it to a limit wait.
Other recoverable failures get one immediate retry. A repeated failure parks the run on the engine, as does a host sandbox failure on its first occurrence.
Once the drive releases its lock, the engine runs any outstanding end checks. <!-- code: src/run/drive.ts#runWorkflow src/run/settle.ts#isParked src/run/execute.ts#formatFailure src/run/settle.ts#runEndChecks -->

## Attempt

`runAttempt` executes one try of one step. A script step passes its command and the variables from `makeScriptEnv` to `runShell`.
A successful exit supplies the output as the reply. The engine still validates that reply and runs the step's checks. <!-- code: src/run/attempt.ts#runAttempt src/run/execute.ts#runShell src/run/check.ts#makeScriptEnv -->

The agent's instructions form the session's system prompt. The turn prompt adds the selected skill bodies to the [workflow context](workflows.md#the-session).
The attempt opens a harness session through `runSession` under a session slot. With `each`, the listing command supplies items in order. Each item opens a fresh session unless the agent sets `session: same`, which gives one session a turn per item. More than twenty items go into one turn. <!-- code: src/context.ts#formatRequest src/context.ts#context src/run/execute.ts#makeAgentSessionSpec src/run/attempt.ts#runAttempt src/run/execute.ts#runSession src/run/checkout.ts#findFanOutItems src/run/checkout.ts#most -->

`parseProposals` reads the last fenced agentgraph block and decodes each proposal as `Said`.
`findUngranted` checks permissions. The pure `pickTryOutcome` can fail the try, ask a question, report a runner problem or return validated work for the remaining checks and writes. <!-- code: src/run/attempt.ts#parseProposals src/run/attempt.ts#findUngranted src/run/attempt.ts#pickTryOutcome -->

The ordinary path runs the step checks, applies proposals and then files child issues. A successful `run` proposal starts a child.
The parent asks with `waiting.on` set to `run` and the child's id so a later tick can join them. <!-- code: src/run/attempt.ts#runAttempt src/run/check.ts#runStepChecks src/run/settle.ts#writeProposals src/run/start.ts#createIssues -->

During a session the attempt checks for events and refreshes the issue news file once a minute in every concurrency mode. With `concurrency: cancel`, an answer interrupts work. With `steer`, the engine can resume the session with a missed answer.
With `queue`, the drive holds the answer until the try finishes. <!-- code: src/run/attempt.ts#runAttempt src/run/drive.ts#runWorkflow -->

## Checks

`runStepChecks` writes the proposals, context and reply to files, then schedules the step's checks together through `runOneCheck`.
For a script check with a result schema, `readScriptResult` reads the last output line and `findMismatch` validates the value. See [check results](checks.md#results).
A judged check opens an agent session through `runJudge`. The judge calls the result tool to record its decision. <!-- code: src/run/check.ts#runStepChecks src/run/check.ts#runOneCheck src/result.ts#readScriptResult src/result.ts#findMismatch src/run/execute.ts#runJudge -->

The store appends each `CheckEntry` to `checks.jsonl`. When the logging policy keeps output, the entry points to a file under `logs/` named by its content hash. <!-- code: src/run/check.ts#runStepChecks src/run/check.ts#runOneCheck src/types.ts#CheckEntry src/store.ts#fileStore -->

When the workflow ends, `transition` marks its end checks as `owed`.
`runEndChecks` evaluates them against saved work with mode `info` or `warn`. It removes each finished check from `owed` and saves the run so a later pass can finish the rest. The verdict leaves the run's outcome intact.
The CLI uses `runLaterChecks` to evaluate selected checks on ended runs. <!-- code: src/workflow.ts#transition src/run/settle.ts#runEndChecks src/run/evaluate.ts#runEndedChecks src/run/evaluate.ts#runLaterChecks -->

## Settle

`writeProposals` sends pushes to `Tracker.apply` first. A failed push blocks later writes except replies to specific threads. Those replies tell their readers that the changes did not reach the pull request. <!-- code: src/run/settle.ts#writeProposals -->

For a try's writes, `getOperationKey` hashes the run id, step, try, rounds, issue number, proposal position and contents. For a push it includes the tree.
`findAppliedBefore` looks for a successful receipt in the trace. For a recoverable post it also asks the tracker for the hidden operation marker.
`writeOnce` reuses the receipt or writes and records a new one. A crash after posting can therefore be recovered without posting the same body twice. <!-- code: src/run/settle.ts#getOperationKey src/run/settle.ts#findAppliedBefore src/run/settle.ts#writeOnce src/tracker.ts#isPostedBy -->

`writeStatus` computes the issue's status across its visible runs. On a change, it updates the tracker's display when enabled and calls the status hooks after a successful change.
Each question goes on the pull request if there is one, otherwise on the issue. It mentions the latest trusted human actor or, if there is none, the issue author. The status header starts on the issue and moves to its pull request. Quiet feedback and conflict workflows skip these public updates. <!-- code: src/run/settle.ts#writeStatus src/context.ts#findIssueStatus src/context.ts#proposeQuestion src/workflow.ts#isQuiet -->

## Follow and merge

Catch-up brings an open pull request up to date when its base branch moves. `runCatchUp` uses a push with `merge: true` for the default merge policy, a rebase for the rebase policy, and skips the base move for `none`.
For a conflict it uses the step's conflict setting, then a conflict workflow if one exists, then the back target or a question.
After a clean move it records the old and new commits in `moved`. Human review waits and eligible done runs can run checks again. Other waits keep the range for the next session. <!-- code: src/run/follow.ts#runCatchUp src/run/trigger.ts#tick -->

A stacked run builds on another pull request. `runFollow` rebases it onto the parent's new head, or rebases and retargets it when the parent merges.
`readBaseGain` assembles the commit log, diff and referenced issues so the next session can see what the base gained. <!-- code: src/run/follow.ts#runFollow src/run/follow.ts#readBaseGain src/run/drive.ts#runWorkflow -->

A merge proposal must name a pull request from the run's own branch. The tracker performs the merge.
On a later pass the merged event normally passes the human wait. The state machine advances to the next step or finishes the run. Closing the issue stops it. <!-- code: src/run/attempt.ts#pickTryOutcome src/tracker.ts#Tracker src/workflow.ts#getHeard src/workflow.ts#getEventOutcome src/workflow.ts#transition -->

## Slots and limits

A slot gives one operation permission to run. `limits.parallel` bounds checkouts and shell commands, and `limits.sessions` bounds harness sessions. See the [resource limits](reference.md#settingsyaml) for defaults.
`waitForSlot` wraps the operation. The queue in `makeSlots` ranks later workflow steps first, then earlier start times. Only a drive sets its rank. Slot requests outside a drive take priority over every queued drive. These requests include catch-up, follow, end checks, asides and CLI checks. A comment router, a workflow that forwards text to other runs, bypasses the queue during its drive. <!-- code: src/run/execute.ts#makeSlots src/run/execute.ts#slotRankRef src/run/execute.ts#waitForSlot src/folder.ts#Limits src/run/drive.ts#runWorkflow -->

The drive checks `usdPerRun` between tries, so one session can take spend past the limit.
An ordinary run at its limit waits with `waiting.on` set to `limits`. A quiet workflow stops. <!-- code: src/run/drive.ts#runWorkflow src/workflow.ts#isQuiet -->

## The store on disk

The file store uses `getRecordPath` to locate each run's [snapshot, trace and check results](runs.md#the-data-folder). <!-- code: src/store.ts#fileStore src/store.ts#getRecordPath src/labels.ts#readRunLabels -->

`put` records the end time when a run finishes. It appends changed fields to the trace in a `saved` line, then calls `writeFileAtomic` to write, sync and rename the snapshot into place.
For trace and check appends, `appendJsonlRows` takes a lock, repairs a torn final line and syncs the new rows. Readers report and skip a final line that ends in incomplete JSON. <!-- code: src/store.ts#fileStore src/store.ts#writeFileAtomic src/store.ts#appendJsonlRows src/store.ts#parseJsonlRows -->

`writeIdleRunsCompressed` checks the modification time of each ended run's trace and check files. It compresses files older than the configured threshold.
Readers try the plain file and then its compressed `.zst` counterpart. <!-- code: src/store.ts#writeIdleRunsCompressed src/store.ts#readRecordSync src/services.ts#settings -->

Run locks last for an Effect scope. `createLock` writes owner information beside the target, then hard-links it into place. A later process can take over a dead owner's lock.
Look under `<data>/.locks/` for locks named after run ids, `status-<issue>` and `refuse-<key>`. Machine-wide heartbeats, loop locks, environment use times and pins use `AGENTGRAPH_STATE`, normally `~/.cache/agentgraph`. <!-- code: src/store.ts#fileStore src/owner.ts#createLock src/owner.ts#readStateDir src/run/settle.ts#writeStatus src/run/trigger.ts#tick src/disk.ts src/env.ts -->

Git retains work separately from the run snapshot. `refs/agentgraph/runs/<id>` preserves the tree between steps, each try has a numbered attempt ref, and `refs/agentgraph/graphs/<tree>` retains the starting graph. <!-- code: src/run/drive.ts#runWorkflow src/git.ts#ensureGraphRef src/env.ts#getCheckoutPaths -->

## Trackers

`pickTracker` resolves built-in and graph plugins to a [tracker setup](plugins.md#trackers). When the name matches no plugin, an existing folder is accepted as a folder tracker. An unknown name with no matching folder is an error. <!-- code: src/tracker.ts#TrackerSetup src/services.ts#pickTracker src/services.ts#makeTrackerSetup src/trackers.ts -->

The folder tracker serializes writes to the [tracker folder](runs.md#the-tracker-folder) with `runLocked`. The tracker turns hand-edited labels into events and publishes a push with a git lease into its origin repository. <!-- code: src/tracker.ts#folderTracker src/tracker.ts#runLocked src/tracker.ts#findIssueDir -->

The GitHub tracker uses `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY` to obtain installation tokens scoped to the operation.
It caches REST reads with ETags and uses GraphQL for project boards. A push writes trees, commits and refs through the Git Data API.
Its event stream reads issue comments, pull request review comments and issue events. It reads reviews on every open pull request and commits only on open agent pull requests from the same repository. <!-- code: src/github.ts#githubTracker src/github.ts#github -->

The tracker sets `Event.trusted` before the engine sees an event. See [trust and scope](workflows.md#trust-and-scope) for the actor rules.
The tracker withholds untrusted text from the agent. Posts that carry run context include a visible link mark and a hidden comment such as `<!-- agentgraph run=... step=... operation=... at=... -->`.
The tracker uses `isPostedBy` in its post lookup to recover a write by operation key. <!-- code: src/github.ts#githubTracker src/tracker.ts#folderTracker src/tracker.ts#makePostableProposal src/tracker.ts#isPostedBy -->

## Mirror and git

`makeSandbox` builds the git side of the sandbox over a runner. For hosted work it keeps a bare copy, the mirror, at `<data>/mirror.git` and fetches before preparing a checkout.
For a local folder tracker the mirror is the tracker's own `origin.git`. Publishing from the checkout goes through `Tracker.apply`. <!-- code: src/mirror.ts#makeSandbox src/tracker.ts#Tracker -->

A run checkout is a detached Git worktree under `<data>/cache/work/<checkout-id>` with a private index. The sandbox generates a random id for each checkout. Its `git` field holds `GIT_DIR`, `GIT_WORK_TREE` and `GIT_INDEX_FILE` for commands that access it.
The sandbox restores the run's saved tree and saves it back to the run ref when the scope closes. It then removes the worktree.
At startup it tries to preserve a dead owner's checkout under `refs/agentgraph/reaped/<checkout-id>` before cleanup. <!-- code: src/mirror.ts#makeSandbox src/types.ts#Checkout src/env.ts#getCheckoutPaths src/env.ts#findDeadCheckouts -->

`Checkout.base` identifies the base commit, `head` the branch tip when it differs, `saved` the saved work and `published` the last published tree's commit.
The `news` field points to the session's issue updates in `news.md`. `hostGit` restricts the environment and disables hooks, global config and prompting.
`commitCheckout` names the expected old commit when updating a ref. `mergeTreeOnto` computes a merge with git's merge-tree operation without modifying the worktree. <!-- code: src/types.ts#Checkout src/git.ts#hostGit src/git.ts#commitCheckout src/git.ts#mergeTreeOnto src/git.ts#commitPublishedTree -->

## Runners and Docker

`pickRunner` chooses the plugin that provides the runner layer. The local plugin uses `dockerRunner`. The box plugin connects `boxRunner` to `AGENTGRAPH_SANDBOX_URL`. <!-- code: src/runners.ts#local src/runners.ts#box src/services.ts#pickRunner src/remote.ts#boxRunner -->

The local runner checks disk space before preparing a command environment. `readSandboxSetup` looks for reusable setup from the repository's toolchain and dependencies, using dependency manifests or a whole-tree key.
`createSharedMounts` prepares dependency mounts, including overlays for directories such as `node_modules` and `target`. The returned box streams each command from a Docker container. <!-- code: src/docker.ts#dockerRunner src/disk.ts#ensureFreeDisk src/env.ts#readSandboxSetup src/env.ts#createSharedMounts -->

`dockerArgs` describes the container policy. It selects a read-only root, a non-root user, dropped capabilities and memory, CPU and process limits.
See [the sandbox](sandbox.md#the-sandbox) for mounts and [the network](sandbox.md#the-network) for command access. <!-- code: src/docker.ts#dockerArgs src/sandbox.ts#inside src/types.ts#Command -->

`ensureDockerHost` sets up networks, builds local sandbox and egress images when needed and starts the egress proxy.
For remote work, `makeBoxRunner` uses git to transfer the worktree and streams output back. The built-in box uses HTTP. The Modal plugin implements the same operations. <!-- code: src/docker.ts#ensureDockerHost src/remote.ts#makeBoxRunner src/remote.ts#boxRunner examples/plugins/modal/modal.ts -->

## Sessions and harnesses

`harnessSession` implements the session service over the sandbox. It looks up the harness named by the session specification and creates, resumes or forks a session home under `<data>/homes/`.
It runs the harness command on the proxy network, decodes its JSON lines into session events, redacts known secrets and prices recorded usage. <!-- code: src/harnesses.ts#harnessSession src/harnesses.ts#Provider src/prices.ts#getListPriceUsd -->

`readHarnessSettings` imports the selected `AGENTGRAPH_CONFIG` file or loads the bundled `agentgraph.config.ts` through `#config`. Harnesses register in that config separately from graph plugins. <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings agentgraph.config.ts -->

`startTools` serves the step's selected plugin tools through an authenticated MCP server reachable from its sandbox.
Judges have a small result server inside the sandbox, built by `makeResultServer`, for submitting a structured verdict. <!-- code: src/tools.ts#startTools src/result.ts#makeResultServer src/run/execute.ts#runJudge -->

## The studio

From a clone, `agi studio` starts the watcher for one instance. The watcher launches the Vite dev server and restarts it when engine or CLI source changes.
`readInstanceServed` builds a reader with `makeInstanceHost` for each instance the dev server serves. <!-- code: bin/run.ts studio/watch.ts studio/dev.ts studio/served.ts#readInstanceServed src/engine.ts#makeInstanceHost -->

The browser uses `runActions` to call the `Actions` RPC group at `/api/actions`.
Authenticated readers can inspect runs. The `label` action writes run labels, and `say` posts comments on a local tracker. A store opened with `?data=` allows reads only. The local actions for instructions, reviews, merge, export, close and pruning are restricted to the CLI through `runLocalActions`.
`startWatch` watches the graph, instance files and data directory and sends changed topics to the page.
`pickAuth` selects the auth plugin, including the built-in none, token and password options. <!-- code: src/engine.ts#makeActionWebHandler src/engine.ts#runLocalActions src/actions.ts#Actions src/actions.ts#runActions studio/served.ts#startWatch src/auths.ts#token src/services.ts#pickAuth -->

DocsPage bundles the Markdown pages in `docs/`. An H2 in the index names a sidebar section. List entries under it add linked pages in order. Pages that have yet to appear in a list go under More. <!-- code: studio/src/docs/DocsPage.tsx -->

For tools that span stores, `makeEngineHost(plugin, configs)` lists allowed stores and reads runs with their labels and latest checks.
A host opened for submission validates labels, records the plugin name in the origin and accepts a started or imported run.
The clone's Bench command can submit. Its example studio page reads the instance hosts it receives. <!-- code: src/engine.ts#EngineHost src/engine.ts#Submission src/engine.ts#makeEngineHost bench/runs.ts#makeSetHost examples/plugins/bench/plugins/bench.ts -->
