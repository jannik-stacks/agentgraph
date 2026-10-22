# The loop

A run walks a workflow on one issue. Each agent step works in a session, checks judge the result, and the engine applies its [proposals](proposals.md).

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

A workflow is `workflows/<name>.md` in the hub. Its frontmatter defines triggers and steps; its body is the description, or the prompt without steps. [Hub files](reference.md#workflows) lists fields and defaults.

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

Steps run in written order. Each names one of `agent`, `run` (a shell command) or `wait: human`. An agent step gets the skill named by `skill`, otherwise the skill matching its step name, if present. Without `steps`, the workflow has one agent step named after its file.

`checks: [tests]` names `checks/tests.md`; a missing check fails hub loading. <!-- code: src/workflow.ts#load -->

`each` on an agent step opens a fresh session per changed file (`files`), diff hunk (`hunks`), or output line (`{ run: <command> }`). These sessions never resume. Past 20 items, one session handles them all. <!-- code: src/engine.ts#most -->

## Starting a run

- `issue_comment`: a trusted comment containing `/agent` or `@agent` as a word, outside quotes and fenced code. The marker is removed before the agent reads it; a bare marker works.
- `issues` with `label`: a trusted person adds that label to an open issue.

`pull_request` and `branches` are accepted but start nothing. Other runs use [dispatch](#dispatch); human feedback can start a [retro](compound.md#the-retro). <!-- code: src/forge.ts#called -->

With several comment workflows, `/agent` selects the first, or the workflow named by its first word, as in `/agent plan`. With no live run, `/agent stop` and `/agent cancel` start nothing. Other comments start a comment workflow even after earlier runs finish. Comments without the marker are context, never answers. Pull request comments and review comments count for their run's issue; bot comments never count. See [Routing](#routing) when another workflow already holds the issue. <!-- code: src/engine.ts#tick -->

A comment asking for no work can end the run after the first session with comments only, skipping checks and later steps. This requires a workflow without a branch, an open pull request, or a finished run of that workflow on the issue. Otherwise a first session allowed to push fails if it returns comments only. Unpushed file changes also fail such a reply.

`/agent restart` stops a live run and starts the workflow again, keeping its human answers. `/agent restart implement` starts at that step. The engine reacts with eyes to a starting or waking comment, or to the issue for a label, and removes the reaction after replying. <!-- code: src/engine.ts#tick -->

A workflow can accept both triggers: `on: { issue_comment: {}, issues: { label: agent:ready } }`. A label starts it only once per issue after a completed run; use restart to run it again. One live run holds an issue at a time. A label added while another workflow holds it is ignored; add it again afterward. Removing a live run's trigger label stops it. A label added and removed before polling starts nothing. <!-- code: src/workflow.ts#reenter -->

## Dispatch

An agent allowed to return `run` can propose:

```json
{"kind": "run", "workflow": "triage", "issue": 12, "step": "implement"}
```

`step` is optional. The try fails unless the target workflow accepts `dispatch`, the issue is open and in scope, no other live run holds it, and this is the try's only `run`. <!-- code: src/engine.ts#undispatchable -->

After the other proposals land, the child starts with `by` set to the parent's id. The parent silently waits with `waiting on <child id>`. When the child asks, finishes or stops, the parent's kept session resumes with that result as an answer. It can comment, dispatch again or do nothing. A child's question is posted and answered on the child's issue. <!-- code: src/engine.ts#dispatch src/engine.ts#settled -->

### Routing

Only `issue_comment` workflows hear people's `/agent` comments directly. A hub can use one as a router, including beside another workflow's live run. Its `returns` controls what it can do: reply with `comment`, file an `issue`, dispatch with `run`, or forward text with `tell`. <!-- code: src/engine.ts#heardBy -->

```json
{"kind": "tell", "issue": 12, "text": "stop"}
```

The recipient hears the text as a maintainer command: feedback, an answer, `stop` or `cancel`. No other live run on that issue means refusal. The router traces the applied proposal; the recipient records `told` with the router's id. The router keeps the person's original reply location. <!-- code: src/engine.ts#tellsOf -->

In `examples/sandbox`, the router triages, forwards, files follow-ups or replies. Building waits for a person to add `agent:ready`. [CLI routing commands](local.md#the-cli) provide the same entry points.

## Trust and scope

By default, owners, members and collaborators steer the bot; label actors must have write access. Outsider comments and labels start nothing, and their text is withheld from agents.

The bot's own comments, labels and issues start nothing. Agents cannot add workflow trigger labels. The exception is an `XL` split part, which the engine [triages again](stacks.md#filing-sub-issues). <!-- code: src/engine.ts#gate -->

`trust: [ana, bob]` narrows trust to those logins and the bot itself, though the bot still cannot trigger runs. The list is read at startup. A hub that fails to load trusts nobody until restart. <!-- code: src/github.ts#githubForge -->

`milestone` limits new runs to open issues in that milestone. Live runs continue. Agent-filed issues have no milestone until a person adds one. <!-- code: src/engine.ts#inScope -->

## The session

The agent body becomes its system prompt. Claude Code and pi append it to their defaults; opencode replaces its base prompt but keeps environment, tools and skills.

The prompt includes the step's skill and its `uses`, workflow body, issue and comments, branch pull request and reviews, target branch, `until`, feedback and allowed proposal shapes. The reply ends with a fenced `agentgraph` block. <!-- code: src/context.ts#context -->

Every minute, the engine writes issue and pull request updates to a news file. Agents with `read` are told to read it before finishing. Resumed sessions receive only feedback and new context. Each agent selects its own [harness and model](sandbox.md#harnesses). <!-- code: src/context.ts#news -->

## Checks

After a session, all step checks run in parallel, including agent checks when scripts fail. All failed findings return together. <!-- code: src/engine.ts#gate -->

| Mode | Failure |
| --- | --- |
| `warn` | Record it and continue |
| `block` | Fail the try and return output as feedback |
| `stop` | Stop the run |

A check names `run`, `agent` or both. Scripts pass on exit 0. Agents judge the diff, fan-out item, or script output, replying `PASS` or `FAIL` first.

A judging session that crashes, times out, is killed or gives no verdict retries once. A second failure parks the run for `block` or `stop`; it is an error, not review feedback. A `warn` check records it and continues. A genuine failing `stop` check still stops the run if another judge errors. <!-- code: src/engine.ts#verdictOf -->

Check `each` fans out over `files`, `hunks` or command output lines. Any failed item fails the check. No items passes with `empty` and "Judged nothing". More than `max` items (default 20) fails as one finding. A nonzero slicer command fails once with its output.

Judges always get fresh sessions without earlier verdicts. Passed items are reused within the run while the diff and judge prompt match; changed checks or human answers trigger judging again. Failed items always rerun, as do all items after runner restart. Judges reading traces are never cached. The studio names reviewers on the step. <!-- code: src/engine.ts#passes src/graph.ts#graphOf -->

Scripts run in the checkout with these variables: <!-- code: src/engine.ts#resultOf -->

| Variable | Contents | Given to |
| --- | --- | --- |
| `AGENTGRAPH_BASE` | Change's starting commit, or branch fork point | Checks and steps |
| `AGENTGRAPH_HUB` | Read-only hub folder | Checks and steps |
| `AGENTGRAPH_ISSUE` | Issue number | Checks |
| `AGENTGRAPH_PROPOSALS` | JSON file of pending proposals | Checks |
| `AGENTGRAPH_CONTEXT` | Issue, pull request and human answers | Checks |
| `AGENTGRAPH_REPLY` | Try's reply | Checks |
| `AGENTGRAPH_TRACES` | [Run traces](compound.md#reading-traces) | Checks |
| `AGENTGRAPH_ITEM` | Fan-out item | Checks |

## Tries and going back

Failed checks or proposals retry in the same session with findings as feedback. `tries` includes the first attempt; exhaustion makes the run wait and explain why on the issue.

`back: implement` permits returning to that step. Agent steps also require `until`, the condition for satisfaction. A `back` proposal supplies the reason as feedback. `rounds` caps returns; exhaustion makes the run wait.

At `wait: human` with `back`, a review requesting changes returns to that step with its line comments. Approval, an `approved` label or merging passes the step. Other `/agent` comments go to an [aside](#asides). <!-- code: src/workflow.ts#reenter -->

Forward transitions start fresh sessions; going back resumes the earlier session. <!-- code: src/workflow.ts#transition -->

## Waiting

Runs wait at `wait: human`, on `ask`, or when tries or rounds run out. Questions are posted separately on the issue. Answer with `/agent` on the thread to resume the same step. Answers stay paired with their questions and reach every later check: in agent prompts and at the end of `AGENTGRAPH_CONTEXT`. Judges are told not to raise points an answer settled. <!-- code: src/engine.ts#heard -->

The status comment shows how to answer; [CLI status](local.md#the-cli) lists commands to continue. `/agent stop` or closing the issue ends a waiting or working run. <!-- code: src/context.ts#answerWith src/workflow.ts#reenter -->

## Asides

An aside answers `/agent` comments at a human wait step. The engine forks the session that `back` targets, copies its home and opens a throwaway checkout of the pull request head with the same agent and tools. Without a kept session it starts fresh. See [harness fork commands](sandbox.md#harnesses). <!-- code: src/engine.ts#aside -->

Only comments and `back` proposals apply. Comments answer the human's thread and leave the run waiting. A `back` resumes work with its reason and adopts the fork as the target step's session. Checkout edits are discarded. Aside cost counts toward the run; its trace sits under the waiting step. Without an open pull request, the comment sends the run back directly. <!-- code: src/engine.ts#tick -->

## Comments while it works

A trusted `/agent` comment reaches the working run according to `concurrency`: <!-- code: src/engine.ts#attempt -->

- `steer` (default): continue working, expose the comment in news, then resume for one turn with unseen comments before checks. Checks judge that turn's reply.
- `queue`: finish the try and checks first, then apply the comment as an answer. A failed try receives it with findings; a passing try passes it to the next step; an `ask` receives it as its answer. If the run finishes first, it starts the comment workflow.
- `cancel`: stop the session and immediately resume the step in the same session with the comment as feedback. The interrupted try does not count.

Explicit `/agent cancel` parks the step and asks how to continue, preserving tries and session. `/agent stop` ends the run. Both release the session slot immediately; the engine checks for them every minute during sessions and checks. <!-- code: src/workflow.ts#reenter -->

Bursts become one ordered answer. The first `stop` or `cancel` wins. The polling loop waits for 30 seconds of quiet before starting or waking a run. Consumed comments never start later runs. <!-- code: src/workflow.ts#fold src/engine.ts#settle src/engine.ts#told -->

## A hub in the repo

`AGENTGRAPH_HUB` selects a repo folder (`.agentgraph` by default) or an absolute local path, as `--hub <dir>` supplies. <!-- code: src/hub.ts#hubAt -->

A repo hub reloads on every poll from the default branch head. Pull request changes take effect only after merging. Trust is read only at runner startup. <!-- code: src/main.ts#start -->

## When the base or the hub moves

Every sweep checks runs at human wait steps against their pull request base and hub version.

`follow` selects the base update: `merge` (default) merges and pushes normally, preserving branch commits; `rebase` replays and force-pushes. The schema also accepts `none`, intended to disable following, but the current engine treats it as `merge`. <!-- code: src/workflow.ts#Step src/engine.ts#catchUp -->

After updating, the engine compares changes with `git patch-id`:

- Same change: rerun the wait step's `checks`. These default to the script checks of its `back` target; `checks: []` skips them. Judged checks run only after scripts pass and receive base changes in `AGENTGRAPH_REPLY`.
- Different change or new hub: run every check of the `back` target under the current hub.

Setup runs first. Passing leaves the run waiting; failed checks return it with findings as feedback. The hub version hashes `hub.yaml`, agents, skills, checks, workflows and scripts; runs record the version last checked. <!-- code: src/engine.ts#catchUp -->

Conflicts also return the run. Its checkout starts at the new base with the change applied and markers left for the agent to resolve. The engine handles git: the next push is one commit on the base for `rebase`, or a merge for `merge`. Leftover markers fail the try. A repeated conflict at the same base head prompts once for a manual update. Up-to-date runs are left alone. <!-- code: src/engine.ts#following -->

## Status on the issue

One status comment shows step, open question, stop reason, pull request, failing GitHub checks and, once the run ends, its cost. Tries, rounds and running cost stay in the studio, so the comment changes only when something a human acts on does. One label tracks `agentgraph:working`, `agentgraph:waiting`, `agentgraph:done` or `agentgraph:stopped`. After an answer, the old status marks its question as answered and a new status appears below the answer. <!-- code: src/context.ts#shown src/engine.ts#tick -->

## Order and limits

Runs sort by priority: `priority/high`, then unlabelled or `priority/medium`, then `priority/low`; oldest first within each group. `limits.parallel` caps simultaneous runs, and `limits.sessions` caps sessions including judges. <!-- code: src/engine.ts#tick src/engine.ts#gateOf -->

`minutes` is a wall-clock deadline, even while output continues. Exceeding `usd-per-run` stops the run. Runner errors, including timeouts, provider faults, failed setup and missing check commands (exit 127), retry once automatically, then park at the step with details in the trace. A reply retries with session and tries kept. <!-- code: src/engine.ts#drive -->
