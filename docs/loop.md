# The loop

A run walks a workflow on one issue. Each agent step works in a session, checks judge the result, and the engine applies the step's [proposals](proposals.md).

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

## Workflows

A workflow is `workflows/<name>.md` in the hub. Its frontmatter holds triggers and steps; [Hub files](reference.md#workflows) lists every field.

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

## Starting a run

- `issue_comment`: a trusted comment with `/agent` or `@agent` as a word, outside quotes and code blocks. The marker is cut before the agent reads the comment, and a bare marker works.
- `issues` with a `label`: a trusted person adds that label to an open issue. In a forge folder, a [dropped issue file](forge.md#dropped-issue-files) with an author and labels counts too, and [`start`](local.md#the-cli) writes one and runs it at once.

`pull_request` and `branches` are accepted but start nothing yet. Other runs start through [dispatch](#dispatch), and human feedback can start a [retro](compound.md#the-retro). <!-- code: src/forge.ts#called -->

With several comment workflows, `/agent` starts the first, or the one its first word names, as in `/agent plan`. With no live run, `/agent stop` and `/agent cancel` start nothing. Comments without the marker are context, never answers. Comments on the issue's pull request count for the issue; bot comments never count. <!-- code: src/engine.ts#tick -->

A comment that asks for no work can end the run after the first session with only comments, skipping checks and later steps. That needs a workflow without a branch, an open pull request, or a finished run of that workflow on the issue. Otherwise a first session that may push fails when it changed nothing.

`/agent restart` stops the live run and starts the workflow again, keeping its human answers. `/agent restart implement` starts at that step. The engine puts an eyes reaction on the comment (or the issue, for a label) and removes it after replying. <!-- code: src/engine.ts#tick -->

A workflow can take both triggers: `on: { issue_comment: {}, issues: { label: agent:ready } }`. A label starts it once per issue; after a run finishes, use restart. One live run holds an issue at a time, and a label added meanwhile is ignored. Removing a live run's trigger label stops it. <!-- code: src/workflow.ts#getEventOutcome -->

## Dispatch

An agent that may return `run` can start another workflow:

```json
{"kind": "run", "workflow": "triage", "issue": 12, "step": "implement"}
```

`step` is optional. The try fails unless the target accepts `dispatch`, the issue is open and in scope, no other live run holds it, and this is the try's only `run`. <!-- code: src/engine.ts#undispatchable -->

The child starts with `by` set to the parent's id, and the parent waits with `waiting on <child id>`. When the child asks, finishes or stops, the parent's session resumes with that result as an answer. The child's questions are answered on the child's issue. <!-- code: src/engine.ts#dispatch src/engine.ts#settled -->

### Routing

An `issue_comment` workflow whose agent may `tell` is a router, and it runs beside another workflow's live run. In a hub with a router, only `issue_comment` workflows hear people's `/agent` comments; the others hear what the router tells them. Its `returns` decides what it can do: reply with `comment`, file an `issue`, dispatch with `run`, or forward text with `tell`. <!-- code: src/engine.ts#heardBy -->

```json
{"kind": "tell", "issue": 12, "text": "stop"}
```

The live run on that issue hears the text as a maintainer command: feedback, an answer, `stop` or `cancel`. With no live run the proposal is refused. The recipient's trace records `told` with the router's id, and its replies go where the person spoke. <!-- code: src/engine.ts#tellsOf -->

In `examples/sandbox` the router triages, forwards, files follow-ups or replies, and building waits for a person to add `agent:ready`.

## Trust and scope

Owners, members and collaborators steer the bot by default; label actors need write access. `trust` in `hub.yaml` narrows this to a list of logins. Outsiders' comments and labels start nothing, and their text is withheld from agents. The trust list is read at startup, and a hub that fails to load trusts nobody until restart. <!-- code: src/github.ts#githubForge -->

The bot's own comments, labels and issues start nothing, and agents cannot add trigger labels. The one exception is an `XL` split part, which the engine [triages again](stacks.md#filing-sub-issues). <!-- code: src/engine.ts#runStepChecks -->

`milestone` limits new runs to issues in that milestone; live runs and split parts go on. <!-- code: src/engine.ts#inScope -->

## The session

The agent body becomes the system prompt. Claude Code and pi append it to their own; opencode replaces its base prompt but keeps environment, tools and skills.

The prompt holds the step's skill and its `uses`, the workflow body, the issue and comments, the branch's pull request and reviews, the target branch, `until`, the step's checks, feedback and the allowed proposal shapes. A fresh session of a step with `back` also sees the branch diff. <!-- code: src/context.ts#context -->

Every minute the engine writes new issue and pull request activity to a news file, and agents with the `read` tool are told to read it before finishing. A resumed session gets only feedback and new context. <!-- code: src/context.ts#news -->

## Checks

After a session, all the step's checks run in parallel. All findings come back together. <!-- code: src/engine.ts#runStepChecks -->

| Mode | On failure |
| --- | --- |
| `warn` | Record it and go on |
| `block` | Fail the try; the output is feedback |
| `stop` | Stop the run |

A check has a `run` script, an `agent` judge or both. A script alone passes on exit 0; with a judge, the judge decides. A judge reads the diff, the fan-out item or the script output and answers `PASS` or `FAIL` first.

A judge that crashes, times out or gives no verdict is retried. If it keeps failing, a `block` or `stop` check parks the run as a runner error, not as review feedback, and a `warn` check records it. <!-- code: src/engine.ts#verdictOf -->

A check's `each` judges every item on its own, and any failed item fails the check. No items passes with "Judged nothing". More than `max` items fail as one finding, and a failing slicer command fails once with its output.

Judges always start fresh. Within a run, a passed item is reused while the diff and the judge prompt are the same; failed items, changed checks, new human answers and a runner restart judge again. Judges that read traces are never reused. <!-- code: src/engine.ts#passes src/graph.ts#makeWorkflowGraph -->

Scripts run in the checkout with these variables: <!-- code: src/engine.ts#resultOf -->

| Variable | Contents | Given to |
| --- | --- | --- |
| `AGENTGRAPH_BASE` | The change's starting commit, or the branch fork point | Everything |
| `AGENTGRAPH_HUB` | The hub folder, read only | Everything |
| `AGENTGRAPH_ISSUE` | Issue number | Checks |
| `AGENTGRAPH_PROPOSALS` | JSON file of pending proposals | Checks |
| `AGENTGRAPH_CONTEXT` | Issue, pull request and human answers | Checks |
| `AGENTGRAPH_REPLY` | The try's reply | Checks |
| `AGENTGRAPH_TRACES` | [Run traces](compound.md#reading-traces) | Checks |
| `AGENTGRAPH_ITEM` | The fan-out item | Checks |

"Everything" means checks, `run` steps, step slicers and hub setup.

### Numbers

A check with `returns: number` measures instead of only passing. With a judge or `each`, its value is the share of items that passed. A script alone gives the number its output ends with, on its own line. `pass` keeps its meaning either way. <!-- code: src/engine.ts#lastNumber -->

A number check without a value is `empty`, with the reason in its findings: no items, no number in the output, or a `warn` judge without a verdict on an item. Readers skip an empty result; it never counts as 0.

### At run end and later

A workflow's `checks` run once when its run ends, done or stopped, on a throwaway checkout of the run's kept files, with the change measured from the run's `fork` and an empty reply. Each check starts from the files as setup left them. They must be `warn` and never change the run's status. The run keeps them in `owed` until each result is traced, so a runner killed partway runs only the rest on its next pass. A check that cannot run there, missing kept files included, gives an empty result. <!-- code: src/workflow.ts#transition src/engine.ts#runEndChecks -->

`npx agentgraph check <name>... --runs` runs checks the same way on runs that already ended, as `warn`. `--workflow` and `--issue` narrow the runs.

## Tries and going back

Failed checks or proposals retry in the same session with the findings as feedback. When `tries` run out, the run waits and says why on the issue.

`back: implement` lets a step send the run back to `implement`. An agent step with `back` also needs `until`, the condition that satisfies it. A `back` proposal carries the reason as feedback. `rounds` caps the returns; when they run out, the run waits.

At a `wait: human` step with `back`, a review requesting changes returns to that step with its line comments. Approval, an `approved` label or a merge passes the step. Other `/agent` comments go to an [aside](#asides). <!-- code: src/workflow.ts#getEventOutcome -->

Going forward starts a fresh session; going back resumes the earlier one. <!-- code: src/workflow.ts#transition -->

## Waiting

A run waits at `wait: human`, on `ask`, or when tries or rounds run out. The question is its own comment where the person last spoke. Answer with `/agent` to resume the same step. At a human wait step out of rounds, the next thing a human says there, a review or an `/agent` comment, grants one more round. Answers stay paired with their questions and reach every later step and check, at the end of `AGENTGRAPH_CONTEXT` for scripts. Judges are told not to raise points an answer settled. <!-- code: src/engine.ts#heard -->

The status comment shows how to answer, and [`status`](local.md#the-cli) lists the commands to continue. `/agent stop` or closing the issue ends the run. <!-- code: src/context.ts#answerWith src/workflow.ts#getEventOutcome -->

## Asides

At a human wait step, an aside answers `/agent` comments. The engine forks the session that `back` targets into a throwaway checkout of the pull request head, with the same agent and tools. Without a kept session it starts fresh. <!-- code: src/engine.ts#aside -->

Only comments and `back` apply. A comment answers the person and leaves the run waiting. A `back` resumes work with its reason, and the fork becomes the target step's session. Edits in the checkout are dropped. The aside's cost counts toward the run. Without an open pull request, the comment sends the run back directly. <!-- code: src/engine.ts#tick -->

## Comments while it works

A trusted `/agent` comment reaches a working run according to the workflow's `concurrency`: <!-- code: src/engine.ts#attempt -->

- `steer` (default): the session goes on and sees the comment in its news. Before checks, it resumes for one more turn with the comments it has not seen, and checks judge that turn.
- `queue`: the try and its checks finish first, then the comment applies as an answer. If the run ends first, the comment starts the comment workflow.
- `cancel`: the session stops and the step resumes at once with the comment as feedback. The cut try does not count.

`/agent cancel` parks the step and asks how to go on, keeping tries and session. `/agent stop` ends the run. The engine looks for both every minute, also during checks. <!-- code: src/workflow.ts#getEventOutcome -->

Several comments in a row become one answer, and the first `stop` or `cancel` wins. The loop waits for 30 seconds of quiet before it starts or wakes a run. A comment that was used never starts a later run. <!-- code: src/workflow.ts#fold src/engine.ts#issueDebounceMs src/engine.ts#told -->

## A hub in the repo

`AGENTGRAPH_HUB` is a folder in the repo (`.agentgraph` by default) or an absolute local path, as `--hub <dir>` gives. Inside the sandbox the same variable names the read-only hub copy. <!-- code: src/services.ts#hubAt -->

A repo hub reloads on every poll from the head of the default branch, so changes in a pull request apply only after merging. <!-- code: src/main.ts#start -->

## When the base or the hub moves

Every pass compares runs waiting at a human step with their pull request's base and the hub version. Stacked runs follow their parent instead, as [Stacks](stacks.md#stacks-on-and-depends-on) describes.

The step's `follow` decides what a moved base does: `merge` (default) merges and pushes, keeping branch commits; `rebase` replays them and force-pushes; `none` leaves the branch behind. <!-- code: src/workflow.ts#Step src/engine.ts#catchUp -->

After an update the engine compares the change with `git patch-id`:

- Same change: rerun the wait step's `checks`. Judges run only after scripts pass and get the base changes in `AGENTGRAPH_REPLY`.
- Different change or new hub: run every check of the `back` target under the current hub.

A wait step without `back` runs no checks. Passing leaves the run waiting; failed checks send it back with the findings. The hub version hashes `hub.yaml`, agents, skills, checks, workflows and scripts. <!-- code: src/engine.ts#catchUp -->

A conflict also sends the run back. Its checkout starts at the new base with the change applied and conflict markers left for the agent. The engine does the git work: the next push is one commit on the base for `rebase`, or a merge for `merge`. Leftover markers fail the try. A second conflict at the same base asks for a manual update. <!-- code: src/engine.ts#following -->

## Status on the issue

One status comment shows the step, whether a question is open, the stop reason, the pull request, failing GitHub checks and, once the run ends, its cost. It changes only when a person has something to do; tries, rounds and running cost are in the studio, which it links when `AGENTGRAPH_STUDIO_URL` is set. One label shows `agentgraph:working`, `agentgraph:waiting`, `agentgraph:done` or `agentgraph:stopped`. After an answer, a new status comment appears below it. <!-- code: src/context.ts#proposeStatusUpdates src/engine.ts#tick -->

## Order and limits

`limits.parallel` caps how many issues a pass handles at once, and `limits.sessions` caps sessions, judges included. Runs that one look drives together go oldest first. <!-- code: src/engine.ts#tick src/engine.ts#gateOf -->

`minutes` is a wall-clock deadline. After each try, a run that is still working stops if it spent more than `usd-per-run`. Runner errors (timeouts, provider faults, failed setup, a missing check command with exit 127) retry once, then park the run at its step with details in the trace. Any reply retries with the session and tries kept. <!-- code: src/engine.ts#drive -->
