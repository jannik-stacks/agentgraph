# Workflows

A run walks a workflow on one issue. Each agent step works in a session, [checks](checks.md) judge the result, and the engine applies the step's [proposals](proposals.md).

```
 agent session ends with proposals <──────────────────┐
   │                                                  │
   ├──> ask: wait for an answer                       │
   v                                                  │
 checks run in parallel                               │
   ├──> block fails: feedback, next try ──────────────┘
   ├──> stop fails: stop the run
   v
 checks pass
   ├──> back: resume an earlier step with the reason
   v
 apply proposals, enter the next step
```

## Steps

A workflow is `workflows/<name>.md`; [the graph folder](reference.md#workflows) lists every field.

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
    until: the change does what the issue asks and the tests cover it
  merge: { wait: human, back: implement }
```

Steps run in order. Each is an `agent` step, a `run` step (a shell command) or a `wait: human` step. An agent step gets the skill named by `skill`, else the one named like the step. A workflow without `steps` is one agent step named after its file, with its body as the prompt. <!-- code: src/workflow.ts#compileWorkflow -->

`each` on an agent step opens one fresh session per changed file (`files`), hunk (`hunks`) or output line of `{ run: <command> }`. These never resume. Past 20 items, one session gets them all. <!-- code: src/run/checkout.ts#most -->

### Gates

A `run` step that exits 0 passes, and the proposals in a fenced `agentgraph` block it prints apply like an agent's, limited by the step's `returns`. That list defaults to `[run]`, so a repo command such as `npm test` can't push, open a pull request, comment or merge. A script that needs more lists it, as in `gate: { run: node gate.mjs, returns: [run, comment] }`. Unlike an agent, a script gets no `ask` or `back` unless listed. Any other kind fails the try, and nothing it printed applies. <!-- code: src/graph.ts#getStepReturns -->

A script that prints a `run` proposal only when a condition holds sends the run into an extra workflow, and the run waits for it at that step. When the step runs again after the child settles, its run trace holds the applied `run`, so the script can pass. A `run` step gets the traces only with `reads: traces`, because writing them reads every run on the issue on each try. <!-- code: src/run/attempt.ts#runAttempt src/workflow.ts#compileWorkflow -->

`examples/retro-gate` counts the failed tool calls in the run's trace after the implement step. Past five, it starts a `retro` workflow whose agent reads the traces and files a `graph` issue per recurring cause with the edit to a skill, agent prompt or `AGENTS.md` that would have prevented it.

## What starts a run

The GitHub tracker uses these built-in triggers: <!-- code: src/workflow.ts#isIssueTriggered -->

- `issue_comment`: a trusted comment with `/agent` or `@agent` as a word, outside quotes and code. The marker is cut before the agent reads it.
- `issues` with a `label`: a trusted person adds that label to an open issue.
- `issues` with a `column`: the open issue's card is in that column of a GitHub project board, the option of its Status field, spelled exactly. See [Project boards](#project-boards).

To start a run by hand, use `agi dispatch 12 --workflow issue`. Runs can also start from an agent's [dispatch](#dispatch), a [retro](#retros), or a [conflict](#when-the-base-or-the-graph-moves). <!-- code: src/run/trigger.ts#instruct -->

More triggers are planned through [plugins](extending.md#plugins-in-progress); `pull_request` and `branches` are accepted but do not trigger runs yet. <!-- code: src/workflow.ts#Front -->

With several comment workflows, `/agent` starts the first. Comments without the marker are context. Comments on the issue's pull request count for the issue; bot comments never do. An eyes reaction marks the comment or issue until the engine replies. <!-- code: src/run/trigger.ts#tick -->

### Commands

`/agent <text>` is always text: a start, an answer or feedback, whatever its first word. A command joins its words to `/agent` with colons and no spaces: <!-- code: src/workflow.ts#pickCommandTarget src/tracker.ts#makeCommentWithAgentRequest -->

| Comment | What it does |
| --- | --- |
| `/agent:stop [reason]` | Ends the live run |
| `/agent:cancel` | Parks the working step and asks how to go on |
| `/agent:restart` | Starts the issue's newest workflow again, with its human answers |
| `/agent:restart:<step>` | The same, from that step |
| `/agent:<workflow> [text]` | Starts that comment workflow, or answers its live run |
| `/agent:<workflow>:restart[:<step>]` | Starts that comment workflow again |

`commands` in `settings.yaml` says who may use each command; a workflow pick counts under the workflow's name. `true` or no entry lets everyone in `trust` use it, `false` turns it off, and a list of logins keeps it to those trusted logins. The gate holds for every command, from a comment, `agi say` or a router `tell`. A command the router passes on counts as said by the router run, so a list of logins keeps it from the router. <!-- code: src/folder.ts#Graph -->

```yaml
commands:
  restart: [jannik-stacks]
  stop: true
```

A command goes to one run, even beside a router: the newest run that was live when it was said, or the live run of the workflow it names. A restart starts that run's workflow again once no run of it is live, or the issue's newest workflow when none was live.

A command that is unknown, names an unknown step, or is turned off or kept from its author does nothing and is not feedback. The engine answers it once on the issue with why, and with the valid commands for an unknown one. A refused `tell` fails the router's proposal with the same reason, and so does a `tell` that names a workflow with no live run. `agi check` fails a workflow named `stop`, `cancel` or `restart`, and a `commands` entry that names neither a command nor a comment workflow. <!-- code: src/run/trigger.ts#tick src/workflow.ts#compileWorkflow -->

A comment that asks for no work can end the run after one session that only comments. That works without a branch, with an open pull request, or after a finished run of that workflow. Otherwise a first session that may push fails when it changed nothing.

A workflow can take both triggers: `on: { issue_comment: {}, issues: { label: agent:ready } }`. A label starts it once per issue; after that, use `/agent:restart`. One live run holds an issue, a label added meanwhile is ignored, and removing a live run's trigger label stops it. <!-- code: src/workflow.ts#getEventOutcome -->

## Project boards

GitHub sends no event when a card moves, so the engine reads the board on each pass, in one GraphQL query per 100 open issues. A card that entered the column after the newest run began starts a run, once per issue like a label. <!-- code: src/github.ts#githubTracker src/run/trigger.ts#tick -->

```yaml
on: { issues: { column: Agent Ready } } # any board the repo owner owns
on: { issues: { column: Agent Ready, project: jannik-stacks/1 } } # only this board
on: { issues: { label: agent:ready, column: Agent Ready } } # the column adds the label
```

GitHub does not say who moved a card, so the board is what is trusted: a board the repo owner owns, or the one `project` names. A card on anyone else's board starts nothing, since anyone can add a public issue to a board of their own.

With both `label` and `column`, either starts the run, and a run started from the column puts the label on the issue. The label stays the one visible sign of agent work, and removing it stops the run as before. Moving the card out of the column does not stop a run. `examples/board` and `examples/board-label` show both. <!-- code: src/run/trigger.ts#tick -->

A GitHub App cannot read the boards of a personal account, so the board is read with a user token that has the `read:project` scope: `AGENTGRAPH_PROJECT_TOKEN`, or else `gh auth token`. Without one, each pass logs once which scope is missing and how to get it, and column triggers start nothing. Labels and comments still go through the App. <!-- code: src/github.ts#readProjectToken -->

To mirror the [status label](#status-on-the-issue) onto the board, add the board plugin from `examples/board/plugins/board.ts` to the graph's `plugins/`. Under `fields`, name each single-select field of the board and map statuses to its options. On each status change it sets every listed field, and clears a field that has no entry for the new status. It adds the issue to the project when missing. Writing fields needs the `project` scope on the same token: `gh auth refresh -s project`. <!-- code: examples/board/plugins/board.ts src/github.ts#githubTracker -->

```yaml
plugins:
  board:
    project: jannik-stacks/1
    fields:
      Status: { working: In Progress, needs-review: In Review, needs-answer: Waiting, done: Done }
      Needs: { needs-answer: Stuck, needs-review: Review } # what needs you; cleared otherwise
```

## Trust and scope

Owners, members and collaborators steer the bot; label actors need write access. `trust` in `settings.yaml` narrows this to a list of logins, read at startup. Outsiders start nothing and agents never see their text. A graph that fails to load trusts nobody. Locally, the instance owner is the only trusted login. <!-- code: src/github.ts#githubTracker -->

The bot's own comments, labels and issues start nothing, and agents cannot add trigger labels, except an `XL` part the engine [triages again](proposals.md#filing-issues). `milestone` limits new runs to issues in that milestone. <!-- code: src/run/check.ts#runStepChecks src/run/hear.ts#isInScope -->

## Dispatch

A human can start any workflow of the graph on an open issue in scope that no live run holds, the router included. `on` decides only what starts a run on its own. A text given with it is what the run was asked, first in its prompt as if a trusted `/agent` comment had started it:

```sh
agi dispatch 12 "what is left on this issue?" --workflow router
```

The run's trace records the text as `spoken`, and the run replies where a comment-started run would. <!-- code: src/run/trigger.ts#instruct src/context.ts#formatRequest -->

An agent that may return `run` can start a workflow with `on: dispatch`:

```json
{ "kind": "run", "workflow": "triage", "issue": 12, "step": "implement" }
```

`step` is optional. The issue must be open, in scope and free, and the try may hold only this one `run`. The child gets `by` set to the parent's id, and the parent waits. When the child asks, finishes or stops, the parent resumes with that as an answer. <!-- code: src/run/start.ts#findUndispatchable src/run/start.ts#startProposedRun src/run/trigger.ts#settled -->

### Routing

An `issue_comment` workflow whose agent may `tell` is a router and runs beside other live runs. In a graph with a router, only `issue_comment` workflows hear `/agent` comments; the others hear what the router tells them. <!-- code: src/run/hear.ts#getHeardEvent -->

```json
{ "kind": "tell", "issue": 12, "text": ":stop" }
```

The live run on that issue hears the text as a maintainer comment: feedback, an answer, `:stop` or `:cancel`. Work runs take priority over retros. At a human wait step with `back`, feedback sends the run back directly. Without a live run the proposal is refused. The trace records `told` with the router's id. <!-- code: src/run/start.ts#findRecipient src/run/hear.ts#readRunEvents src/run/trigger.ts#tick -->

## The session

The agent's body becomes the system prompt; opencode uses it in place of its base prompt, the others append it. The prompt holds the skill and its `uses`, the workflow body, the issue, the pull request and reviews, the target branch, `until`, the step's checks, feedback and the allowed proposals. A fresh session of a step with `back` also sees the branch diff. <!-- code: src/context.ts#context -->

Every minute the engine writes new issue activity to a news file, which agents with `read` read before finishing. A resumed session gets only feedback and new context. <!-- code: src/context.ts#news -->

## Tries and going back

Set `carry: true` on a step to pass its successful reply text, without proposal blocks, to the next step under `## What the <step> step reported`. Steps omit replies by default; carried text stays in the run record, outside the checkout. <!-- code: src/run/trigger.ts#tick src/workflow.ts#transition -->

Failed checks or proposals retry in the same session with the findings as feedback, answered in code, not in a comment. When `tries` run out, the run waits and says why. <!-- code: src/workflow.ts#transition -->

`back: implement` lets a step send the run back with a reason. An agent step with `back` also needs `until`. `rounds` caps the returns, then the run waits. Going forward starts a fresh session; going back resumes the earlier one.

At a `wait: human` step with `back`, a review requesting changes goes back with its line comments. Approval, an `approved` label or a merge passes the step. Other `/agent` comments go to an [aside](#asides). <!-- code: src/workflow.ts#getEventOutcome -->

## Waiting

A run waits at `wait: human`, on `ask`, or when tries or rounds run out. The question is its own comment; answer with `/agent` to resume the step. Out of rounds, the next review or `/agent` comment grants one more. Answers stay paired with their questions for every later step and check. `/agent:stop` or closing the issue ends the run. <!-- code: src/run/check.ts#formatAnswers src/context.ts#answerWith -->

## Asides

At a human wait step, an aside answers `/agent` comments. It forks the session `back` targets into a throwaway checkout of the pull request head, or starts fresh. Only comments and `back` apply: a comment answers and the run keeps waiting; a `back` resumes work, and the fork becomes that step's session. The answering agent comments only when its `returns` lists `comment`; any kind it may not use fails the aside, and nothing from that reply is posted. Edits are dropped. Without an open pull request, the comment sends the run back directly. <!-- code: src/run/follow.ts#runAside -->

## Comments while it works

A trusted `/agent` comment reaches a working run by the workflow's `concurrency`: <!-- code: src/run/attempt.ts#runAttempt -->

- `steer` (default): the session sees it in its news, and resumes for one more turn before checks if it missed any.
- `queue`: the try and its checks finish, then the comment applies as an answer.
- `cancel`: the session stops and the step resumes with the comment as feedback; the cut try does not count.

`/agent:cancel` parks the step and asks how to go on. `/agent:stop` ends the run. Comments in a row become one answer, and the first command wins. The engine waits for 30 seconds of quiet before it starts or wakes a run. <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#fold src/run/trigger.ts#issueDebounceMs src/run/hear.ts#readHeardOutcome -->

## When the base or the graph moves

A catch-up error is recorded once in the run trace. The run stays waiting and retries when the base head, branch head or graph changes. <!-- code: src/run/trigger.ts#tick -->

A stacked run records its parent pull request in `base`. After a refused follow, `from` keeps the last successful base and `tip` records the branch head that failed. It retries when either head moves. An unknown tip is not recorded and does not block a retry. A refused follow adds its question after the one the run already waits on, and a later follow drops only its own. <!-- code: src/run/follow.ts#runFollow src/workflow.ts#Run -->

Runs waiting at a human step are compared with their base and the graph version. The step's `follow` decides what a moved base does: `merge` (default) merges and pushes, `rebase` force-pushes a rebased branch, `none` leaves it. Stacked runs follow their [parent](proposals.md#stacks-on-and-depends-on). <!-- code: src/workflow.ts#Step src/run/follow.ts#runCatchUp -->

If `git patch-id` shows the same change, the wait step's `checks` run again, with the base changes in `AGENTGRAPH_REPLY`. If the change or graph differs, every check of the `back` target runs. Failed checks send the run back. The graph version hashes `settings.yaml`, agents, skills, checks, workflows and scripts.

A conflict sends the run back to a checkout at the new base with the markers left for the agent; leftover markers fail the try. A second conflict at the same base asks for a manual update. <!-- code: src/run/follow.ts#moveCheckoutOnto -->

A graph with an `on: conflict` workflow sends conflicts there instead. The waiting run stays where it is, and a new run of that workflow, `by` the waiting one, starts on the new base with the change applied, the markers left and the conflict as its feedback. It has a budget of its own and pushes to the same branch, so give it the same `branch`. Like a retro it shares the issue’s sticky status, hears no comments while working and stops where it would ask; while it is live, the waiting run does not catch up. `examples/conflicts` resolves conflicts this way with a small model. <!-- code: src/run/follow.ts#runCatchUp src/workflow.ts#isQuiet -->

## Status on the issue

One sticky comment on the issue covers every run, including retros and conflict runs. Its visible line shows the current state. The collapsed ⁂ footer holds one table row per run: workflow, step, state, cost so far, pull request, failing checks and studio link when configured. Cost updates at the existing status update points. Every engine comment and PR body uses that footer, linked to the studio when configured and plain ⁂ otherwise, followed by its hidden marker.

The sticky stays on the issue because the PR description already links there. Conflict notices and exhausted-check details stay in the sticky. Questions stay separate plain comments, with the shared ⁂ footer; the sticky says “waiting for your answer below”. Resuming edits the same sticky. <!-- code: src/context.ts#proposeStatusUpdates -->

On GitHub the issue also carries exactly one status label, so a label filter shows what needs you; a [tracker folder](runs.md#the-tracker-folder) moves the issue into a folder of that name instead. It follows the sticky's visible line, which keeps the current status in a hidden `<!-- status: ... -->` marker, and replaces the previous status label; GitHub creates a missing label on first use. Quiet workflows (feedback and conflict runs) change none. The tracker shows the status, so a tracker plugin can show it its own way. <!-- code: src/event.ts#issueStatuses src/context.ts#proposeStatusUpdates src/tracker.ts#makeStatusLabel -->

The `status` setting renames the labels, or the folders. A status missing from the map gets no label, and the others are still cleared. `status: false` turns status labels off; status hooks still fire. A folder tracker's default names are the bare statuses, since `:` is not valid in a Windows path.

```yaml
# .agentgraph/settings.yaml
status:
  needs-review: review-me
```

| Label                     | When                                                                               |
| --- | --- |
| `agentgraph:working`      | A step runs, or a run waits on a run it started                                    |
| `agentgraph:needs-review` | A run waits at a `wait: human` step with a pull request to review and merge        |
| `agentgraph:needs-answer` | A run asked a question, waits with no pull request, or paused on a runner error    |
| `agentgraph:done`         | The latest run finished                                                            |
| `agentgraph:stopped`      | The latest run stopped                                                             |

With several runs on one issue, a waiting run wins over a working one. After each change, [status hooks](plugins.md#status-hooks) hear about it. <!-- code: src/context.ts#proposeStatusUpdates src/run/settle.ts#announce -->

## Order and limits

`limits.parallel` caps runs driven at once, end checks included, and `limits.sessions` caps sessions and scripts across the process, judges included. Runs go oldest first. `minutes` is a deadline per session, script or setup. A run that spent more than `usd-per-run` stops after its try. <!-- code: src/run/trigger.ts#tick src/run/execute.ts#getGate -->

Alongside full passes, `agi loop` on a hosted tracker polls tracker events every `AGENTGRAPH_EVERY` minutes from the newest event seen; on a tracker folder it passes again on each edit instead. The first cursor overlaps loop startup by five minutes. Quiet polls read only events since that cursor. Trusted events tick their issues and the runs whose pull requests got events, after the same quiet period as a full pass. <!-- code: bin/run.ts#loop src/main.ts#start src/run/trigger.ts#scanTrackerEvents -->

Both paths share cached tracker reads and issue gates. A poll leaves busy or debounced issues due for the next interval and retains their lower cursor, so later events on other issues stay reachable. Poll scans reuse the events already read and never read before their retained poll cursor. A later full pass catches anything they miss. Existing reactions and run cursors prevent handling an event twice. <!-- code: src/run/trigger.ts#scanTrackerEvents src/run/trigger.ts#scanIssuesAndRunningRuns -->

Each pass of `agi loop` reads the issues, answers and starts runs, and hands each working run to a drive in the background. The pass ends without waiting for its drives, so a long run never delays the next pass on other issues. Drives outlive their pass and count against `limits.parallel` across passes; a run over the cap waits for a free slot. <!-- code: src/run/trigger.ts#runPass src/run/trigger.ts#startLoopDrives src/main.ts#start -->

A pass skips a run that is already driving, and the run's lock keeps it to one drive across processes. A drive that waited for a slot first hears what was said meanwhile, so a stop ends it before any session. A drive that settled a run runs its end checks with the graph it drove with; a run settled elsewhere gets them from a later pass. <!-- code: src/run/trigger.ts#runPass -->

The driven run hears what people say between tries and through its session's minute watch, which [`concurrency`](#comments-while-it-works) turns into a steer, a queue or a cancel. Stopping the loop interrupts its drives and releases their locks, and each run goes on from where it was on its next drive. `agi start` and `loop --once` still drive in the foreground. <!-- code: src/run/drive.ts#runWorkflow src/run/attempt.ts#runAttempt src/main.ts#start -->

Runner errors (timeouts, provider faults, failed setup, exit 127) retry once, then park the run. A missing image parks at once. The sticky says “paused on an agentgraph problem, not this change; reply `/agent` to retry”. No separate runner error comment is posted, including for quiet runs. Details stay in the trace and studio, and the pause remains visible in `show`. A key or login the provider rejects stops the run at once. A reply or `resume --parked` retries parked runs, including quiet runs, and clears the pause in the sticky. <!-- code: src/run/drive.ts#runWorkflow -->

## Retros

`on: feedback` starts a retro on trusted comments, change requests, approvals with a comment, and commits people push where a run worked, also after merge. A command without text, such as `/agent:stop`, is not feedback. Feedback is batched after 30 seconds of quiet. <!-- code: src/run/trigger.ts#feedback -->

A run that ends is feedback too: when a run is done or stopped, after a merge, a stop, a restart or a closed pull request, one retro reads how it went. The router's runs, retros and runs that ended over a day ago start none. What is said and what ended in the same look share one retro. A run that waits on a question starts none until a person answers or stops it. <!-- code: src/run/hear.ts#findSettledRuns -->

A retro never holds an issue, shares its sticky status without changing labels, skips setup, and stops where another workflow would wait. Its problems remain visible in the sticky and `show`. It ends with nothing, a [graph change](proposals.md#filing-issues) for a recurring miss, or a follow-up issue. <!-- code: src/workflow.ts#transition -->
