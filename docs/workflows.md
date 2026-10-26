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

A workflow is `workflows/<name>.md` in the graph. [The graph folder](reference.md#workflows) lists every field.

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

Steps run in written order. Each is an `agent` step, a `run` step (a shell command) or a `wait: human` step. An agent step gets the skill named by `skill`, else the skill named like the step. A workflow without `steps` is one agent step named after its file, and its body is the prompt. <!-- code: src/workflow.ts#compileWorkflow -->

`each` on an agent step opens one fresh session per changed file (`files`), diff hunk (`hunks`) or output line of a command (`{ run: <command> }`). These sessions never resume. Past 20 items, one session gets them all. <!-- code: src/engine.ts#most -->

## What starts a run

- `issue_comment`: a trusted comment with `/agent` or `@agent` as a word, outside quotes and code blocks. The marker is cut before the agent reads the comment, and a bare marker works.
- `issues` with a `label`: a trusted person adds that label to an open issue.

`pull_request` and `branches` are accepted but start nothing yet. Other runs start through [dispatch](#dispatch) or as a [retro](#retros). <!-- code: src/forge.ts#makeCommentWithAgentRequest -->

With several comment workflows, `/agent` starts the first, or the one its first word names, as in `/agent plan`. Comments without the marker are context, never answers. Comments on the issue's pull request count for the issue; bot comments never count. `/agent restart` stops the live run and starts the workflow again, keeping its human answers, and `/agent restart implement` starts at that step. The engine puts an eyes reaction on the comment (or the issue, for a label) until it replies. <!-- code: src/engine.ts#tick -->

A comment that asks for no work can end the run after one session that only comments, skipping checks and later steps. That works in a workflow without a branch, with an open pull request, or after a finished run of that workflow on the issue. Otherwise a first session that may push fails when it changed nothing.

A workflow can take both triggers: `on: { issue_comment: {}, issues: { label: agent:ready } }`. A label starts it once per issue; after that, use restart. One live run holds an issue at a time, and a label added meanwhile is ignored. Removing a live run's trigger label stops it. <!-- code: src/workflow.ts#getEventOutcome -->

## Trust and scope

Owners, members and collaborators steer the bot by default; label actors need write access. `trust` in `settings.yaml` narrows this to a list of logins. Outsiders' comments and labels start nothing, and their text is withheld from agents. The trust list is read at startup, and a graph that fails to load trusts nobody until restart. Locally, the instance owner is the only trusted login. <!-- code: src/github.ts#githubForge -->

The bot's own comments, labels and issues start nothing, and agents cannot add trigger labels. The one exception is an `XL` part, which the engine [triages again](proposals.md#filing-issues). `milestone` limits new runs to issues in that milestone; live runs and parts go on. <!-- code: src/engine.ts#runStepChecks src/engine.ts#inScope -->

## Dispatch

An agent that may return `run` can start another workflow:

```json
{"kind": "run", "workflow": "triage", "issue": 12, "step": "implement"}
```

`step` is optional. The try fails unless the target accepts `dispatch`, the issue is open and in scope, no other live run holds it, and this is the try's only `run`. The child gets `by` set to the parent's id, and the parent waits. When the child asks, finishes or stops, the parent's session resumes with that as an answer. The child's questions are answered on the child's issue. <!-- code: src/engine.ts#undispatchable src/engine.ts#dispatch src/engine.ts#settled -->

### Routing

An `issue_comment` workflow whose agent may `tell` is a router, and it runs beside another workflow's live run. In a graph with a router, only `issue_comment` workflows hear people's `/agent` comments; the others hear what the router tells them. The router can reply with `comment`, file an `issue`, dispatch with `run`, or forward text with `tell`. <!-- code: src/engine.ts#heardBy -->

```json
{"kind": "tell", "issue": 12, "text": "stop"}
```

The live run on that issue hears the text as a maintainer command: feedback, an answer, `stop` or `cancel`. With no live run the proposal is refused. The recipient's trace records `told` with the router's id, and its replies go where the person spoke. <!-- code: src/engine.ts#readRunEvents -->

## The session

The agent's body becomes the system prompt. Claude Code and pi append it to their own; opencode replaces its base prompt but keeps environment, tools and skills.

The prompt holds the skill and its `uses`, the workflow body, the issue and comments, the pull request and its reviews, the target branch, `until`, the step's checks, feedback and the allowed proposal shapes. A fresh session of a step with `back` also sees the branch diff. <!-- code: src/context.ts#context -->

Every minute the engine writes new issue and pull request activity to a news file, and agents with the `read` tool are told to read it before finishing. A resumed session gets only feedback and new context. <!-- code: src/context.ts#news -->

## Tries and going back

Failed checks or proposals retry in the same session with the findings as feedback. When nothing from the try applied, the feedback says so and asks for every proposal again. It also tells the agent that only it sees the findings, so it answers them in code, not in a comment. When `tries` run out, the run waits and says why on the issue. <!-- code: src/workflow.ts#transition -->

`back: implement` lets a step send the run back to `implement`, with the reason as feedback. An agent step with `back` also needs `until`. `rounds` caps the returns; when they run out, the run waits. Going forward starts a fresh session; going back resumes the earlier one.

At a `wait: human` step with `back`, a review requesting changes returns to that step with its line comments. Approval, an `approved` label or a merge passes the step. Other `/agent` comments go to an [aside](#asides). <!-- code: src/workflow.ts#getEventOutcome -->

## Waiting

A run waits at `wait: human`, on `ask`, or when tries or rounds run out. The question is its own comment where the person last spoke. Answer with `/agent` to resume the same step. At a human wait step out of rounds, the next review or `/agent` comment grants one more round. Answers stay paired with their questions and reach every later step and check. Judges are told not to raise points an answer settled. `/agent stop` or closing the issue ends the run. <!-- code: src/engine.ts#heard src/context.ts#answerWith -->

## Asides

At a human wait step, an aside answers `/agent` comments. The engine forks the session that `back` targets into a throwaway checkout of the pull request head, with the same agent and tools, or starts fresh without a kept session. <!-- code: src/engine.ts#aside -->

Only comments and `back` apply. A comment answers the person and the run keeps waiting. A `back` resumes work with its reason, and the fork becomes the target step's session. Edits in the checkout are dropped, and the aside's cost counts toward the run. Without an open pull request, the comment sends the run back directly.

## Comments while it works

A trusted `/agent` comment reaches a working run according to the workflow's `concurrency`: <!-- code: src/engine.ts#attempt -->

- `steer` (default): the session goes on and sees the comment in its news. Before checks, it resumes for one more turn with the comments it has not seen.
- `queue`: the try and its checks finish first, then the comment applies as an answer. If the run ends first, the comment starts the comment workflow.
- `cancel`: the session stops and the step resumes at once with the comment as feedback. The cut try does not count.

`/agent cancel` parks the step and asks how to go on, keeping tries and session. `/agent stop` ends the run. With no live run, both start nothing. The engine looks for them every minute, also during checks. <!-- code: src/workflow.ts#getEventOutcome -->

Several comments in a row become one answer, and the first `stop` or `cancel` wins. The engine waits for 30 seconds of quiet before it starts or wakes a run. A comment that was used never starts a later run. <!-- code: src/workflow.ts#fold src/engine.ts#issueDebounceMs src/engine.ts#told -->

## When the base or the graph moves

Every pass compares runs waiting at a human step with their pull request's base and with the graph version. The step's `follow` decides what a moved base does: `merge` (default) merges and pushes; `rebase` replays the branch and force-pushes; `none` leaves it behind. Stacked runs follow their parent instead; see [Proposals](proposals.md#stacks-on-and-depends-on). <!-- code: src/workflow.ts#Step src/engine.ts#catchUp -->

After an update the engine compares the change with `git patch-id`. If it is the same, it reruns the wait step's `checks`; judges run only after scripts pass and get the base changes in `AGENTGRAPH_REPLY`. If the change or the graph differs, it runs every check of the `back` target under the current graph. A wait step without `back` runs no checks. Failed checks send the run back with the findings. The graph version hashes `settings.yaml`, agents, skills, checks, workflows and scripts.

A conflict also sends the run back. The checkout starts at the new base with the change applied and the conflict markers left for the agent. The engine does the git work, and leftover markers fail the try. A second conflict at the same base asks for a manual update. <!-- code: src/engine.ts#following -->

## Status on the issue

One status comment shows the step, an open question, the stop reason, the pull request, failing GitHub checks and, at the end, the cost. It changes only when a person has something to do, and links the studio when `AGENTGRAPH_STUDIO_URL` is set. One label shows `agentgraph:working`, `agentgraph:waiting`, `agentgraph:done` or `agentgraph:stopped`. After an answer, a new status comment appears below it. <!-- code: src/context.ts#proposeStatusUpdates -->

## Order and limits

`limits.parallel` caps how many issues a pass drives at once, and `limits.sessions` caps sessions, judges included. Runs go oldest first. `minutes` is a deadline per session, script or setup. After each try, a run that spent more than `usd-per-run` stops. <!-- code: src/engine.ts#tick src/engine.ts#getSessionGate -->

Runner errors (timeouts, provider faults, failed setup, a missing check command with exit 127) retry once, then park the run at its step with details in the trace. A missing image parks at once and says what to run on the host. Any reply retries with the session and tries kept. <!-- code: src/engine.ts#drive -->

## Retros

`on: feedback` starts a retro on trusted comments, change requests, approvals with a comment, and commits people push where a run worked. Feedback on a pull request counts for its issue, also after merge. A bare `/agent stop`, `cancel` or `restart` is not feedback. Feedback is batched after 30 seconds of quiet, and feedback during a retro starts another one. <!-- code: src/engine.ts#feedback -->

A retro never holds an issue, takes another run's answers or posts a status. It skips setup and stops where another workflow would wait. It ends with nothing and a short reason, a [graph change](proposals.md#filing-issues) for a recurring miss, or a follow-up for work nobody covered. <!-- code: src/workflow.ts#transition -->
