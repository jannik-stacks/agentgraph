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

`each` on an agent step opens one fresh session per changed file (`files`), hunk (`hunks`) or output line of `{ run: <command> }`. These never resume. Past 20 items, one session gets them all. <!-- code: src/engine.ts#most -->

## What starts a run

- `issue_comment`: a trusted comment with `/agent` or `@agent` as a word, outside quotes and code. The marker is cut before the agent reads it.
- `issues` with a `label`: a trusted person adds that label to an open issue.
- `issues` with a `column`: the open issue's card is in that column of a GitHub project board, the option of its Status field, spelled exactly. See [Project boards](#project-boards).

Each field of an `issues` trigger names a source, and the source decides whether an event starts the workflow and whether to trust it. `label` and `column` are the built-in GitHub sources, and a new source is one more entry beside them. <!-- code: src/workflow.ts#isIssueTriggered -->

`pull_request` and `branches` are accepted but start nothing yet. Other runs start through [dispatch](#dispatch), as a [retro](#retros) or on a [conflict](#when-the-base-or-the-graph-moves). <!-- code: src/forge.ts#makeCommentWithAgentRequest -->

With several comment workflows, `/agent` starts the first, or the one its first word names (`/agent plan`). Comments without the marker are context. Comments on the issue's pull request count for the issue; bot comments never do. `/agent restart` starts the workflow again with its human answers, and `/agent restart implement` starts at that step. An eyes reaction marks the comment or issue until the engine replies. <!-- code: src/engine.ts#tick -->

A comment that asks for no work can end the run after one session that only comments. That works without a branch, with an open pull request, or after a finished run of that workflow. Otherwise a first session that may push fails when it changed nothing.

A workflow can take both triggers: `on: { issue_comment: {}, issues: { label: agent:ready } }`. A label starts it once per issue; after that, use restart. One live run holds an issue, a label added meanwhile is ignored, and removing a live run's trigger label stops it. <!-- code: src/workflow.ts#getEventOutcome -->

## Project boards

GitHub sends no event when a card moves, so the engine reads the board on each pass, in one GraphQL query per 100 open issues. A card that entered the column after the newest run began starts a run, once per issue like a label. <!-- code: src/github.ts#githubForge src/engine.ts#tick -->

```yaml
on: { issues: { column: Agent Ready } }                            # any board the repo owner owns
on: { issues: { column: Agent Ready, project: jannik-stacks/1 } }  # only this board
on: { issues: { label: agent:ready, column: Agent Ready } }        # the column adds the label
```

GitHub does not say who moved a card, so the board is what is trusted: a board the repo owner owns, or the one `project` names. A card on anyone else's board starts nothing, since anyone can add a public issue to a board of their own.

With both `label` and `column`, either starts the run, and a run started from the column puts the label on the issue. The label stays the one visible sign of agent work, and removing it stops the run as before. Moving the card out of the column does not stop a run. `examples/board` and `examples/board-label` show both. <!-- code: src/engine.ts#tick -->

A GitHub App cannot read the boards of a personal account, so the board is read with a user token that has the `read:project` scope: `AGENTGRAPH_PROJECT_TOKEN`, or else `gh auth token`. Without one, each pass logs once which scope is missing and how to get it, and column triggers start nothing. Labels and comments still go through the App. <!-- code: src/github.ts#readProjectToken -->

## Trust and scope

Owners, members and collaborators steer the bot; label actors need write access. `trust` in `settings.yaml` narrows this to a list of logins, read at startup. Outsiders start nothing and agents never see their text. A graph that fails to load trusts nobody. Locally, the instance owner is the only trusted login. <!-- code: src/github.ts#githubForge -->

The bot's own comments, labels and issues start nothing, and agents cannot add trigger labels, except an `XL` part the engine [triages again](proposals.md#filing-issues). `milestone` limits new runs to issues in that milestone. <!-- code: src/engine.ts#runStepChecks src/engine.ts#inScope -->

## Dispatch

A human can start any workflow of the graph on an open issue in scope that no live run holds, the router included. `on` decides only what starts a run on its own. A text given with it is what the run was asked, first in its prompt as if a trusted `/agent` comment had started it:

```sh
agi dispatch 12 "what is left on this issue?" --workflow router
```

The run's trace records the text as `spoken`, and the run replies where a comment-started run would. <!-- code: src/engine.ts#instruct src/context.ts#formatRequest -->

An agent that may return `run` can start a workflow with `on: dispatch`:

```json
{"kind": "run", "workflow": "triage", "issue": 12, "step": "implement"}
```

`step` is optional. The issue must be open, in scope and free, and the try may hold only this one `run`. The child gets `by` set to the parent's id, and the parent waits. When the child asks, finishes or stops, the parent resumes with that as an answer. <!-- code: src/engine.ts#undispatchable src/engine.ts#dispatch src/engine.ts#settled -->

### Routing

An `issue_comment` workflow whose agent may `tell` is a router and runs beside other live runs. In a graph with a router, only `issue_comment` workflows hear `/agent` comments; the others hear what the router tells them. <!-- code: src/engine.ts#heardBy -->

```json
{"kind": "tell", "issue": 12, "text": "stop"}
```

The live run on that issue hears the text as a maintainer command: feedback, an answer, `stop` or `cancel`. Without a live run the proposal is refused. The trace records `told` with the router's id. <!-- code: src/engine.ts#readRunEvents -->

## The session

The agent's body becomes the system prompt; opencode uses it in place of its base prompt, the others append it. The prompt holds the skill and its `uses`, the workflow body, the issue, the pull request and reviews, the target branch, `until`, the step's checks, feedback and the allowed proposals. A fresh session of a step with `back` also sees the branch diff. <!-- code: src/context.ts#context -->

Every minute the engine writes new issue activity to a news file, which agents with `read` read before finishing. A resumed session gets only feedback and new context. <!-- code: src/context.ts#news -->

## Tries and going back

Failed checks or proposals retry in the same session with the findings as feedback, answered in code, not in a comment. When `tries` run out, the run waits and says why. <!-- code: src/workflow.ts#transition -->

`back: implement` lets a step send the run back with a reason. An agent step with `back` also needs `until`. `rounds` caps the returns, then the run waits. Going forward starts a fresh session; going back resumes the earlier one.

At a `wait: human` step with `back`, a review requesting changes goes back with its line comments. Approval, an `approved` label or a merge passes the step. Other `/agent` comments go to an [aside](#asides). <!-- code: src/workflow.ts#getEventOutcome -->

## Waiting

A run waits at `wait: human`, on `ask`, or when tries or rounds run out. The question is its own comment; answer with `/agent` to resume the step. Out of rounds, the next review or `/agent` comment grants one more. Answers stay paired with their questions for every later step and check. `/agent stop` or closing the issue ends the run. <!-- code: src/engine.ts#heard src/context.ts#answerWith -->

## Asides

At a human wait step, an aside answers `/agent` comments. It forks the session `back` targets into a throwaway checkout of the pull request head, or starts fresh. Only comments and `back` apply: a comment answers and the run keeps waiting; a `back` resumes work, and the fork becomes that step's session. Edits are dropped. Without an open pull request, the comment sends the run back directly. <!-- code: src/engine.ts#aside -->

## Comments while it works

A trusted `/agent` comment reaches a working run by the workflow's `concurrency`: <!-- code: src/engine.ts#attempt -->

- `steer` (default): the session sees it in its news, and resumes for one more turn before checks if it missed any.
- `queue`: the try and its checks finish, then the comment applies as an answer.
- `cancel`: the session stops and the step resumes with the comment as feedback; the cut try does not count.

`/agent cancel` parks the step and asks how to go on. `/agent stop` ends the run. Comments in a row become one answer, and the first `stop` or `cancel` wins. The engine waits for 30 seconds of quiet before it starts or wakes a run. <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#fold src/engine.ts#issueDebounceMs src/engine.ts#told -->

## When the base or the graph moves

Runs waiting at a human step are compared with their base and the graph version. The step's `follow` decides what a moved base does: `merge` (default) merges and pushes, `rebase` force-pushes a rebased branch, `none` leaves it. Stacked runs follow their [parent](proposals.md#stacks-on-and-depends-on). <!-- code: src/workflow.ts#Step src/engine.ts#catchUp -->

If `git patch-id` shows the same change, the wait step's `checks` run again, with the base changes in `AGENTGRAPH_REPLY`. If the change or graph differs, every check of the `back` target runs. Failed checks send the run back. The graph version hashes `settings.yaml`, agents, skills, checks, workflows and scripts.

A conflict sends the run back to a checkout at the new base with the markers left for the agent; leftover markers fail the try. A second conflict at the same base asks for a manual update. <!-- code: src/engine.ts#following -->

A graph with an `on: conflict` workflow sends conflicts there instead. The waiting run stays where it is, and a new run of that workflow, `by` the waiting one, starts on the new base with the change applied, the markers left and the conflict as its feedback. It has a budget of its own and pushes to the same branch, so give it the same `branch`. Like a retro it posts no status, hears no comments and stops where it would ask; while it is live, the waiting run does not catch up. `examples/conflicts` resolves conflicts this way with a small model. <!-- code: src/engine.ts#catchUp src/workflow.ts#isQuiet -->

## Status on the issue

One status comment shows the step, an open question, the stop reason, the pull request, failing GitHub checks and the final cost, and links the studio when `AGENTGRAPH_STUDIO_URL` is set. One label shows `agentgraph:working`, `agentgraph:waiting`, `agentgraph:done` or `agentgraph:stopped`. <!-- code: src/context.ts#proposeStatusUpdates -->

## Order and limits

`limits.parallel` caps issues driven at once and `limits.sessions` caps sessions, judges included. Runs go oldest first. `minutes` is a deadline per session, script or setup. A run that spent more than `usd-per-run` stops after its try. <!-- code: src/engine.ts#tick src/engine.ts#getSessionGate -->

Runner errors (timeouts, provider faults, failed setup, exit 127) retry once, then park the run with details in the trace. A missing image parks at once and says what to run. A key or login the provider rejects stops the run at once. Any reply retries. <!-- code: src/engine.ts#drive -->

## Retros

`on: feedback` starts a retro on trusted comments, change requests, approvals with a comment, and commits people push where a run worked, also after merge. A bare `/agent stop`, `cancel` or `restart` is not feedback. Feedback is batched after 30 seconds of quiet. <!-- code: src/engine.ts#feedback -->

A retro never holds an issue or posts a status, skips setup, and stops where another workflow would wait. It ends with nothing, a [graph change](proposals.md#filing-issues) for a recurring miss, or a follow-up issue. <!-- code: src/workflow.ts#transition -->
