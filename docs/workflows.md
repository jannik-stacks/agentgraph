# Workflows

A workflow defines ordered steps on an issue. Checks can retry a step or stop the run, and granted proposals can ask, return to an earlier step or start another workflow.

## Steps

A workflow is `workflows/<name>.md`; [the graph folder](reference.md#workflows) lists its fields. For example:

```yaml
on: issue_comment
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    checks: [tests]
  review:
    agent: reviewer
    back: implement
    until: the change meets the issue and tests cover it
  merge: { wait: human, back: implement }
```

Steps run in written order and choose `agent`, `run` or `wait: human`. An agent gets its explicit skill, else the skill named like the step. Without `steps`, the workflow is one agent step with its body as the prompt.

`each` starts fresh sessions for files, hunks or command output lines; above 20 items, one session handles all. <!-- code: src/workflow.ts#compileWorkflow --> <!-- code: src/run/checkout.ts#most -->

### Gates

A `run` step passes on exit 0. It may print proposals in a fenced `agentgraph` block, limited by `returns` (default `[run]`). An ungranted kind fails the try without applying proposals.

A script can conditionally propose `run` to start a child workflow; the parent waits and repeats its step after the child settles. `reads: traces` exposes the run trace to the script. The `examples/retro-gate` graph uses this to request feedback after repeated tool failures. <!-- code: src/graph.ts#getStepReturns --> <!-- code: src/run/attempt.ts#runAttempt src/workflow.ts#compileWorkflow -->

## What starts a run

Configured triggers start runs on these inputs:

- `issue_comment`: a trusted comment containing `/agent` or `@agent` outside quotes and code.
- `issues.label`: a trusted person adds the configured label to an open issue.
- `issues.column`: an open issue enters the configured project Status column.

`agi dispatch 12 --workflow issue` starts a workflow by hand. Runs can also start through [agent dispatch](#dispatch), [feedback](#retros) or [conflicts](#when-the-base-or-the-graph-moves). `pull_request` and `branches` are accepted but start no runs.

With several comment workflows, `/agent` starts the first. Unmarked comments are context; pull request comments count for their issue, and bot comments start nothing. An eyes reaction stays on each comment a run takes.

A label starts its workflow once per issue; use restart for another run. One work run holds an issue, and removing its trigger label stops it. <!-- code: src/workflow.ts#isIssueTriggered --> <!-- code: src/run/trigger.ts#instruct --> <!-- code: src/workflow.ts#Front --> <!-- code: src/run/trigger.ts#tick -->

### Commands

`/agent <text>` supplies text; commands join words with colons:

| Comment                              | What it does                                                     |
| ------------------------------------ | ---------------------------------------------------------------- |
| `/agent:stop [reason]`               | Ends the live run                                                |
| `/agent:cancel`                      | Parks the working step and asks how to go on                     |
| `/agent:restart`                     | Starts the issue's newest workflow again, with its human answers |
| `/agent:restart:<step>`              | The same, from that step                                         |
| `/agent:<workflow> [text]`           | Starts that comment workflow, or answers its live run            |
| `/agent:<workflow>:stop [reason]`    | Ends that workflow's live run                                    |
| `/agent:<workflow>:cancel`           | Parks that workflow's working step and asks how to go on         |
| `/agent:<workflow>:restart[:<step>]` | Starts that comment workflow again                               |

Graph `commands` settings allow each command for everyone trusted (`true`, the default), nobody (`false`) or named trusted logins. These gates also apply to CLI comments and router `tell` proposals. Unknown, disabled or unauthorized commands do nothing and receive a reason.

Commands target one live run, preferring work over a router. Restart begins that workflow again with its human answers. After an unmerged closed pull request, it chooses a fresh suffixed branch; otherwise it keeps the previous branch. Reserved workflow names are `stop`, `cancel` and `restart`.

A comment needing only an answer can finish without a code change. A first session allowed to push otherwise fails if it changes nothing. <!-- code: src/workflow.ts#pickCommandTarget src/workflow.ts#commandVerbs src/tracker.ts#makeCommentWithAgentRequest --> <!-- code: src/workflow.ts#pickCommandTarget src/workflow.ts#CommandSettings --> <!-- code: src/run/drive.ts#runWorkflow src/run/hear.ts#readEarlierBranch src/run/attempt.ts#pickTryOutcome --> <!-- code: src/run/trigger.ts#tick src/workflow.ts#compileWorkflow src/workflow.ts#commandVerbs src/folder.ts#compile --> <!-- code: src/context.ts#formatRequest src/run/attempt.ts#pickTryOutcome --> <!-- code: src/workflow.ts#getEventOutcome -->

## Project boards

Column triggers poll the board on each pass. `project: owner/number` selects a board; otherwise only the repository owner's boards count. With both label and column, either can start a run and the column also adds the label. Moving a card out does not stop work.

Board reads need `AGENTGRAPH_PROJECT_TOKEN` or `gh auth token` with `read:project` scope. Missing access is reported; label and comment triggers remain available. The board example's [plugin](../examples/board/plugins/board.ts) maps run statuses to project fields and needs `project` scope for writes. <!-- code: src/github.ts#githubTracker src/run/trigger.ts#tick --> <!-- code: src/workflow.ts#issueSources --> <!-- code: src/run/trigger.ts#tick --> <!-- code: src/github.ts#readProjectToken --> <!-- code: examples/board/plugins/board.ts src/github.ts#githubTracker -->

## Trust and scope

Instance settings control trusted logins; graph `settings.yaml` rejects `trust`. Owners, members and collaborators can steer runs; label actors need write access. Outsider text is withheld, and an invalid graph trusts nobody.

Bot activity starts nothing, except engine-filed XL parts that restart triage. Agents cannot add trigger labels. `milestone` limits new runs to that milestone. <!-- code: src/github.ts#githubTracker src/settings.ts#getSettings src/harnesses.ts#readOverrides src/settings.ts#InstanceFile src/folder.ts#GraphSettings --> <!-- code: src/run/check.ts#runStepChecks src/run/hear.ts#isInScope -->

## Dispatch

A human can dispatch any workflow on an open, in-scope issue with no live run:

```sh
agi dispatch 12 "what is left on this issue?" --workflow router
```

The text becomes the run's request and is recorded as `spoken`. An agent granted `run` can dispatch only workflows with `on: dispatch`:

```json
{ "kind": "run", "workflow": "triage", "issue": 12, "step": "implement" }
```

`step` is optional; only one `run` proposal is allowed per try. The parent waits until the child asks, waits for review, finishes or stops, then receives the outcome as an answer. <!-- code: src/run/trigger.ts#instruct src/context.ts#formatRequest --> <!-- code: src/run/start.ts#findUndispatchable src/run/start.ts#startProposedRun src/run/start.ts#formatSettled -->

### Routing

An `issue_comment` workflow whose agent may `tell` acts as a router beside work runs. When a router exists, only comment workflows hear `/agent` directly; others hear its forwarded text:

```json
{ "kind": "tell", "issue": 12, "text": ":stop" }
```

The live run hears feedback, answers or commands as maintainer text. Work takes priority over retros; a missing recipient fails the proposal. The trace records `told` with the router's id. <!-- code: src/run/hear.ts#getHeardEvent --> <!-- code: src/run/start.ts#findRecipient src/run/hear.ts#readRunEvents src/run/trigger.ts#tick -->

## The session

The harness receives the agent body as system instructions, plus skills, workflow text, issue and pull request context, feedback, checks and allowed proposals. A fresh step with `back` also receives the branch diff.

The engine updates `/news/news.md` with issue activity every minute. A resumed session receives feedback, changed context and that path. <!-- code: src/context.ts#context --> <!-- code: src/context.ts#news src/sandbox.ts#inside -->

## Tries and going back

`carry: true` passes a successful step's reply text, without proposal blocks, to the next step. Replies are otherwise omitted.

Failed checks or proposals retry in the same session with findings as feedback. Exhausted `tries` make the run wait. `back` resumes this or an earlier step with a reason; an agent step with `back` also requires `until`. `rounds` caps returns. Forward steps start fresh sessions. A resume that fails before the harness starts, or of a session another harness ran, runs once fresh with the full prompt instead.

At `wait: human` with `back`, requested changes return to work. Approval, the `approved` label or merge passes the wait; other comments use an aside. <!-- code: src/run/trigger.ts#tick src/workflow.ts#transition src/workflow.ts#StepFile --> <!-- code: src/workflow.ts#transition --> <!-- code: src/workflow.ts#compileWorkflow src/workflow.ts#transition --> <!-- code: src/workflow.ts#getEventOutcome -->

## Waiting

Runs wait at human steps, on `ask`, or after exhausting tries or rounds. The engine posts a question where the run is speaking: the issue, then its pull request once available. `/agent` answers resume work; answers stay paired with questions for later steps and checks. A reply after exhausted rounds grants one more. A stop command or closed issue ends the run. <!-- code: src/run/check.ts#formatAnswers src/context.ts#proposeQuestion -->

## Asides

At a human wait, an aside answers comments in a throwaway checkout of the pull request head. It forks the `back` target's session, or starts fresh with the whole thread when there is none or it cannot be resumed. Only granted `comment` and `back` proposals apply; edits are discarded. A comment keeps waiting, while `back` resumes work. Without an open pull request, feedback returns directly to work. <!-- code: src/run/follow.ts#runAside -->

## Comments while it works

Workflow `concurrency` controls trusted comments during work:

- `steer` (default): deliver through news, with another turn if the session missed them.
- `queue`: finish the try and checks, then apply the answer.
- `cancel`: interrupt and resume with feedback, without counting the cut try.

`/agent:cancel` parks the step; `/agent:stop` ends it. Consecutive comments combine, with the first command taking priority. Starts and wakeups wait for 30 seconds of quiet. <!-- code: src/run/attempt.ts#runAttempt --> <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#fold src/run/trigger.ts#issueDebounceMs src/run/hear.ts#readHeardOutcome -->

## When the base or the graph moves

A human wait step says what a base move does: `follow` how the branch follows it, `checks` what runs again after a clean follow, and `conflict` what a conflict does.

```yaml
review:
  wait: human
  back: implement
  follow: rebase # merge (default), rebase, or none to leave the branch alone
  checks: [tests, upstream] # [] follows only; default: the back step's script checks
  conflict: back # back, ask, or a workflow with on: conflict
```

```yaml
# checks/upstream.md
mode: block
agent: reviewer
each: merged
```

`each: merged` judges every hunk the base gained. With `upstream` in the wait step's `checks`, a pull request that still calls `fromHex` gets one judgment per merged hunk and goes back when the pull request that removed it says why.

Runs waiting at the step and done runs with an open pull request follow and check. A clean follow reruns the wait checks, scripts first and judged ones once those pass, or all checks of the `back` target if the change or graph differs. A failure goes back, reopening a done run. Runs waiting on a question only follow, and their next session hears what the base gained. Stacked runs follow their [parent](proposals.md#stacks-on-and-depends-on) and check nothing. The graph hash covers settings, prompts, scripts and plugins.

What the base gained is the pull requests and issues named as `#N` in the merged commits, the issues those pull requests close, the commits and the diff. Judges read it with the change's diff, scripts get the old base as `AGENTGRAPH_FROM`, and it ends the feedback of any return to work. The run keeps the followed range until its checks decide, so each base head is checked once.

On a conflict, `back` returns to a checkout with markers for the agent; leftover markers fail the try. A workflow name starts that `on: conflict` workflow to handle the markers in a separate quiet run. `ask` says on the issue to update it by hand, as does a second conflict at the same base.

Catch-up errors wait for the base, branch or graph to change before retrying. A stacked follow its tracker keeps refusing retries three times, then waits for the branch tip to change. Parked runs and older restarts do not catch up. <!-- code: src/run/trigger.ts#tick --> <!-- code: src/run/follow.ts#runFollow src/types.ts#Run --> <!-- code: src/workflow.ts#Step src/run/follow.ts#runCatchUp --> <!-- code: src/run/follow.ts#readBaseGain src/run/checkout.ts#findFanOutItems --> <!-- code: src/run/follow.ts#runCatchUp src/folder.ts#loadGraph --> <!-- code: src/run/follow.ts#moveCheckoutOnto src/run/drive.ts#runWorkflow --> <!-- code: src/run/follow.ts#runCatchUp src/workflow.ts#isQuiet -->

## Status on the issue

The engine derives status from run records. GitHub shows a label; the folder tracker moves the issue into a status folder. A question takes priority over review, then work, then the newest ended run. Quiet workflows do not contribute.

A status header in the issue body moves to the pull request once available and follows every status change, including a run picking the issue up again. The engine replaces only its marked section; other body text remains. Questions notify through comments, while step and check details stay in the studio.

`status` renames labels or folders; omitted entries get no label, and `status: false` disables them. Status hooks still fire.

| Label                     | When                                                                             |
| ------------------------- | -------------------------------------------------------------------------------- |
| `agent:working`           | A step runs, or a run waits on a run it started                                  |
| `agent:needs-review`      | A run waits at a `wait: human` step with a pull request to review and merge      |
| `agent:needs-answer`      | A run asked a question, waits with no pull request, or paused on an engine error |
| `agent:done`              | The latest run finished                                                          |
| `agent:stopped`           | The latest run stopped                                                           | <!-- code: src/event.ts#issueStatuses src/context.ts#findIssueStatus src/run/settle.ts#writeStatus src/tracker.ts#makeStatusLabel --> <!-- code: src/context.ts#formatStatusHeader src/run/settle.ts#writeStatus src/event.ts#makeBodyWithStatus --> <!-- code: src/github.ts#githubTracker src/tracker.ts#folderTracker --> <!-- code: src/context.ts#proposeQuestion --> <!-- code: src/folder.ts#GraphSettings src/tracker.ts#makeStatusLabel --> <!-- code: src/context.ts#findIssueStatus src/run/settle.ts#announce --> |

## Order and limits

`limits.parallel` caps concurrent drives, including end checks; `limits.sessions` caps an instance's sessions and scripts, including judges. `agi loop --parallel <n>` caps drives across instances. Routers take neither slot. `minutes` sets command deadlines, and runs exceeding `usd-per-run` stop after their try.

Loops scan issues and poll hosted tracker events; folder edits trigger another pass. Drives run in the background, oldest first, under per-run locks. Stops interrupt drives; the next drive resumes them. `agi start` and `loop --once` drive in the foreground.

Engine errors retry once, then park the run with a visible reason. A missing image parks immediately; rejected credentials stop the run. A reply or `resume --parked` retries parked runs, including quiet ones. <!-- code: src/run/trigger.ts#tick src/run/trigger.ts#runPass src/run/execute.ts#sessionPermitsRef --> <!-- code: bin/run.ts#serve src/main.ts#start src/run/trigger.ts#scanTrackerEvents --> <!-- code: src/run/trigger.ts#scanTrackerEvents src/run/trigger.ts#scanIssuesAndRunningRuns --> <!-- code: src/run/trigger.ts#runPass src/run/trigger.ts#startLoopDrives src/main.ts#start --> <!-- code: src/run/trigger.ts#runPass --> <!-- code: src/run/drive.ts#runWorkflow src/run/attempt.ts#runAttempt src/main.ts#start --> <!-- code: src/run/drive.ts#runWorkflow src/context.ts#proposeQuestion -->

## Retros

`on: feedback` starts a quiet workflow on trusted comments, reviews, commits and ended work runs. It reads issue and pull request context; outsider text remains withheld. Restarts count only with `on: { feedback: { restarts: true } }`.

Feedback on one issue is batched after 30 seconds of quiet. Router and retro runs, and runs ended over a day ago, start no retro. Waiting alone starts none.

Retros skip setup, never hold an issue or change its status, and stop where ordinary runs would wait. They can file graph or follow-up issues; they post no comments. Problems remain visible in the studio and `show`. <!-- code: src/run/trigger.ts#feedback src/run/hear.ts#findSettledRuns --> <!-- code: src/run/trigger.ts#feedback src/run/trigger.ts#issueDebounceMs --> <!-- code: src/run/hear.ts#findSettledRuns --> <!-- code: src/run/hear.ts#readIssueWithPull --> <!-- code: src/run/trigger.ts#tick src/workflow.ts#isRunDone --> <!-- code: src/workflow.ts#transition -->
