# The loop

A run walks a workflow's steps on one issue. An agent step works in a session, its checks judge the result, and the engine applies what the agent proposed once the checks pass.

```
 the run enters an agent step
   │
   v
 the session works, its reply ends with proposals <──────┐
   │                                                     │
   ├──> ask: the run waits for an answer                 │
   v                                                     │
 checks: scripts at once, then agents                    │
   │                                                     │
   ├──> a block check fails: feedback, next try ─────────┘
   ├──> a stop check fails: the run stops
   v
 all pass
   │
   ├──> back: an earlier step resumes, with the reason
   v
 proposals applied, then the next step
```

When tries or rounds run out, the run waits for a human instead of going on.

## Workflows

A workflow is a Markdown file in the hub's `workflows/` folder, such as `workflows/issue.md`. Its frontmatter says when it starts and what its steps are. Its body is the description, or the prompt when it has no steps. [Hub files](reference.md) lists every field with its default.

```yaml
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
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

Steps run in the order written. Each does one thing:

- `agent: implementor` runs the agent in `agents/implementor.md`. It gets the skill `skill` names, or else the one named like the step, here `skills/implement.md`.
- `run: <command>` runs a script.
- `wait: human` waits for a person.

`checks: [tests]` names files in `checks/`, here `checks/tests.md`. A name that has no file is an error when the hub loads. <!-- code: src/workflow.ts#load -->

A workflow without `steps` is one agent step named after the file, with the agent `agent` names.

`each` on an agent step opens one fresh session per item: `files` for each changed file, `hunks` for each diff hunk, or `{ run: <command> }` for each line the command prints. Such a step never resumes a session. Past 20 items it opens one session over all of them instead. <!-- code: src/engine.ts#most -->

## Starting a run

Two triggers start runs today:

- `issue_comment` with `command`: a comment starting with that text, such as `/bothub`.
- `issues` with `label`: a label added to an issue, such as `triage`.

`pull_request` and `branches` are accepted but start nothing yet. A third way in, `dispatch`, is for runs that other runs start, see [Dispatch](#dispatch).

On GitHub, the main way in is to mention the bot. A comment counts when it has `@stx-bothub` as a word outside quoted lines and fenced code. `/bothub` works the same. The engine reads either as `/bothub` followed by the rest of the comment, so a bare mention starts the workflow too. On an issue with no live run, a mention that only says `stop` or `cancel` starts nothing. <!-- code: src/forge.ts#commanded -->

Once the bot has a run on an issue, a trusted comment there speaks to it without a mention, unless it mentions someone else. Comments on the run's pull request count for its issue, and the bot's own comments never count.

A waiting run takes the comment as its answer, and a working run takes it as its workflow's `concurrency` says, see [Comments while it works](#comments-while-it-works). When every run there is finished, the comment starts the comment workflow, so a question like "where is the PR?" gets a reply.

A run started by a comment can reply and stop. When the comment asks for no work, the first session is told to reply with comments only, and that reply ends the run without checks or later steps. That holds only where the work the comment asks about exists: a workflow without a branch, an open pull request, or a finished run of the workflow on the issue. Elsewhere, and whenever the reply leaves files changed but not pushed, a first session that may push and replies with comments only fails the try.

`/bothub restart` starts the workflow again on an issue whose run is done, stopped or waiting, and `/bothub restart implement` starts it at that step. A waiting or working run stops first. The new run keeps the human answers of the last one, so nothing settled is asked again. <!-- code: src/engine.ts#tick -->

The engine puts an eyes reaction on the comment that started or woke a run, or on the issue for a label, and takes it off once it has replied. <!-- code: src/engine.ts#tick -->

A workflow can start on both, as `on: { issue_comment: { command: /bothub }, issues: { label: agent:ready } }` in `examples/sk`. Then triage and the loop build nothing by themselves: work begins when a maintainer adds `agent:ready` or mentions the bot. A label starts a workflow once per issue: once a run of it there is done, adding the label again starts nothing, and `/bothub restart` runs it again. <!-- code: src/engine.ts#tick -->

The issue must be open, and one run at a time holds it, whatever started it. A label added while another workflow's run is live there starts nothing; add it again once that run ends. Removing the label from an issue with a live run stops that run. A label added and removed before the engine looks starts nothing. <!-- code: src/workflow.ts#reenter -->

## Dispatch

A workflow with `dispatch` under `on` can be started by another run. An agent whose `returns` has `run` proposes `{"kind": "run", "workflow": "triage", "issue": 12}`. The engine refuses it, and the try fails, unless the workflow has `dispatch`, #12 is an open issue in scope, no other live run holds it, and it is the try's only `run`. <!-- code: src/engine.ts#undispatchable -->

Once the try's other proposals land, the engine begins the child run with `by` set to the parent's id. The parent waits with the reason `waiting on <child id>`, and says nothing on the issue about it. <!-- code: src/engine.ts#dispatch -->

```
 parent run proposes run
   |
   v
 child run starts         parent waits on it
   |
   v
 child asks, is done or stops
   |
   v
 parent resumes its session with what happened, and decides
```

The parent hears of it as an answer, such as `triage on #12 is done` or `triage on #12 asks: ...`, in its kept session. It decides with the proposals it has: a comment, another `run`, or nothing. A child's question still goes on the child's issue, and a person answers it there. <!-- code: src/engine.ts#settled -->

A router is a workflow whose agent returns `run`, so what a router may do is just its `returns`. In `examples/sandbox`, a mention starts the router; it starts triage, files a follow-up, or replies. Building waits for a person to add `agent:ready`.

## Trust and scope

Only trusted people steer the bot. By default those are the repo's owners, members and collaborators, and a label counts when its actor may write. Everyone else is an outsider: their comments and labels start nothing, and their text is withheld from agents.

The bot is never trusted either. Its own comments, labels and the issues it files start nothing, so a run begins only on a trusted person's label or command. An agent may not even propose a label that some workflow starts on; that label is a person's call. The one exception is an `XL` part of a split, which the engine triages again, see [Sub-issues and stacks](stacks.md). <!-- code: src/engine.ts#gate -->

`trust: [ana, bob]` in `hub.yaml` narrows that to those logins and the bot itself. A collaborator outside the list is then an outsider too. The runner reads the list when it starts, and a hub that does not load then trusts no one until a restart. <!-- code: src/github.ts#githubForge -->

`milestone` in `hub.yaml` limits new runs to open issues in that milestone. Live runs keep going. Issues an agent files are not put in the milestone, so they wait until a person moves them in. <!-- code: src/engine.ts#inScope -->

## The session

The agent's body goes into the session's system prompt. Claude Code and pi add it after their own default prompt. opencode uses it in place of its base prompt and still adds its environment, tools and skills.

The prompt holds the step's skill and the skills it `uses`, the workflow body, the issue and its comments, the pull request on the run's branch with its reviews, the branch to work on, the `until` sentence, any feedback, and the shape of every proposal the agent may make. The agent ends its reply with a fenced `bothub` block of [proposals](proposals.md). <!-- code: src/context.ts#context -->

While the session works, the engine writes what is new on the issue and its pull request to a news file every minute. An agent with the `read` tool is told to read it before it finishes. A resumed session gets only the feedback and what is new. <!-- code: src/context.ts#news -->

Each agent names its own harness and model, and the proxy gives each agent its own key. So every step and check can run on a different harness, model and provider. <!-- code: src/hub.ts#Agent -->

## Checks

After a session ends, the step's checks run against the checkout, all at once. Agent checks judge a try even when a script check fails, so every finding of a try goes back to the agent together instead of one check per try. That spends judges on a broken build, and when a `stop` check fails it spends them on a run that is ending; both cost less than the tries they save. <!-- code: src/engine.ts#gate -->

| Mode    | When the check fails                               |
| ------- | -------------------------------------------------- |
| `warn`  | It is recorded and never holds the step            |
| `block` | The try fails and the output goes back as feedback |
| `stop`  | The run stops                                      |

A check file holds a script, an agent, or both:

- `run`: exit 0 passes, and the output is the feedback.
- `agent`: the reply must start with `PASS`; `FAIL` is a finding. On its own the agent judges the diff, or the item in a fan-out. A judging session that is killed, crashes, times out or replies without `PASS` or `FAIL` is not a verdict: it is tried once more, and if it fails again, a `block` or `stop` check parks the run with an error saying the check could not be judged, so nothing is fed back to the agent as review feedback. A `warn` check records that error as its finding and the run goes on. A `stop` check that did fail still stops the run when another check could not be judged. <!-- code: src/engine.ts#verdictOf -->
- Both: the script runs and its output goes to the agent.

`each` fans a check out over `files`, `hunks`, or the lines a command prints, and the check fails when any item fails. When there are no items, the check passes marked `empty` with the finding "Judged nothing", so a slicer that lost its input shows up. More items than `max`, 20 unless the check sets it, fail the check as one finding, so no fan-out opens more sessions than that. A command that exits nonzero gives no items: the check fails once with the command's output as the finding.

Several agent checks on one step judge the same try side by side, each in a fresh session, and the findings of those that fail go back together. A reviewer never sees its own earlier verdict. An item an agent check passed is not judged again in the same run while the diff and the judge's prompt stay the same, so a new human answer or a changed check is judged afresh. A failed item is judged again every try, and every item after the runner restarts. <!-- code: src/engine.ts#passes --> The studio marks such a step with a chip naming the reviewers. <!-- code: src/graph.ts#graphOf -->

```yaml
implement:
  agent: implementor
  checks: [tests, claude-review, gpt-review]
```

Scripts run with the checkout as their working directory and get these variables: <!-- code: src/engine.ts#resultOf -->

| Variable           | What it holds                                                | Given to         |
| ------------------ | ------------------------------------------------------------ | ---------------- |
| `BOTHUB_BASE`      | Where the change starts: on a branch, where it forks from the base | checks and steps |
| `BOTHUB_HUB`       | The hub folder, read-only                                    | checks and steps |
| `BOTHUB_ISSUE`     | The issue number                                             | checks           |
| `BOTHUB_PROPOSALS` | A JSON file of the proposals the try made                    | checks           |
| `BOTHUB_CONTEXT`   | A file with the issue and pull request as the agent saw them, then the human answers | checks           |
| `BOTHUB_REPLY`     | A file with the try's reply                                  | checks           |
| `BOTHUB_TRACES`    | A file with the traces of the runs on the issue, see [Reading traces](compound.md#reading-traces) | checks |
| `BOTHUB_ITEM`      | The item, in a fan-out                                       | checks           |

## Tries and going back

A failed try starts another in the same session, with each failing check's output and each failed proposal as feedback. `tries` counts the first one. When tries run out, the run waits and says why on the issue.

`back: implement` lets a step send the run to an earlier step. An agent step with `back` also needs `until`, a sentence saying when the step is satisfied. While it does not hold, the agent proposes `back` with a reason, and the reason becomes feedback for the earlier step. `rounds` caps how often that happens. When rounds run out, the run waits.

A `wait: human` step with `back` goes back when a human requests changes in a review. The line comments that came with or just before the review join its reason. An approving review, an `approved` label or a merge passes it. Anything else a human says there, a comment, a line comment or a mention, goes to an [aside](#asides). <!-- code: src/workflow.ts#reenter -->

Going forward into a step starts a fresh session. Going back resumes the session that step had. <!-- code: src/workflow.ts#transition -->

## Waiting

A run waits when an agent proposes `ask`, when tries or rounds run out, and at a `wait: human` step. The engine posts the question as its own comment on the issue.

A human answers by replying on the thread, with no mention needed, and the answer becomes feedback for the same step. The run keeps every answer with its question, and every later check reads them: an agent check in its prompt, with the note that a point an answer settles is not a finding, and a script at the end of `BOTHUB_CONTEXT`. <!-- code: src/engine.ts#heard --> A reply that says only `stop` ends the run, waiting or working, and so does closing the issue. The status comment carries that hint while a question waits. <!-- code: src/context.ts#answerWith --> <!-- code: src/workflow.ts#reenter -->

`node bin/run.ts status` lists what waits, with the command that continues each run. <!-- code: src/status.ts#needsYou -->

## Asides

An aside answers what a human says to a run waiting at a `wait: human` step, without reworking the pull request. Say a maintainer asks under a line of the pull request "so this was already documented elsewhere?". That is a question, not a request for changes.

The engine forks the session of the step `back` leads to, so the fork knows that session's history while the session itself stays as it was. The fork runs in a copy of the session's home, in a throwaway checkout of the pull request head, with the same agent and tools. Without a kept session, a fresh session with that step's agent answers. <!-- code: src/engine.ts#aside --> How each harness forks is in [Harnesses](sandbox.md#harnesses).

The fork answers with a comment, posted under the thread the human wrote in, and the run keeps waiting. When the comment asks for a change, or the fork finds one is needed, it also proposes `back`. Then the run goes back as a request for changes would, with the fork's reason as feedback, and the fork becomes that step's session, so the next try goes on from what the fork read. Nothing else an aside proposes is applied, and whatever it changes in its checkout is thrown away. Its cost counts toward the run, and its session is in the run's trace under the waiting step. With no pull request open there is nothing to check out, and what the human says sends the run back. <!-- code: src/engine.ts#tick -->

## Comments while it works

A trusted comment on the issue or pull request of a working run goes to that run. It never starts a second run there. The workflow's `concurrency` decides when the run takes it in: <!-- code: src/engine.ts#attempt -->

- `steer`, the default: the session goes on and finds the comment in its news file. When the session ends, the engine resumes it for one more turn with every comment it has not seen, before the checks run.
- `queue`: the try ends as if nothing was said. Then the comment applies as an answer would.
- `cancel`: the engine stops the session and starts the step again at once, in the same session, with the comment as feedback. The cut try does not count.

Say the bot implements #12, and two minutes in a maintainer writes "use the v2 API".

- With `steer`, the agent can read it in the news file and switch at once. When it finishes, it gets one more turn that holds the comment, and its reply from that turn is the one the checks judge.
- With `queue`, the agent finishes on its old plan and the checks run. If the try fails, the next try gets the check findings and the comment. If it passes, the review step gets the comment as feedback. If the agent asked a question, the comment is the answer. If the run is done by then, the comment starts the comment workflow, as on any finished run.
- With `cancel`, the engine sees the comment within a minute, stops the session and resumes it with "use the v2 API" as feedback.

Two replies work at any time, as a plain reply or a mention:

- `cancel` stops the current session or checks now and parks the run at its step. The engine asks how to go on, and a reply resumes the same session with its tries kept.
- `stop` ends the run, working or waiting.

Both free the session's slot at once. While a session or its checks run, the engine looks for them once a minute. <!-- code: src/workflow.ts#reenter -->

Several comments in a row count once. A run takes in everything said since it last looked as one answer, in order, and when a burst holds `stop` or `cancel`, the first of them decides. <!-- code: src/workflow.ts#fold --> The loop also waits until an issue has been quiet for 30 seconds before what people did there starts or wakes a run. <!-- code: src/engine.ts#settle --> A comment a run has taken in never starts another run later. <!-- code: src/engine.ts#told -->

The setting follows GitHub Actions `concurrency`, where the group is always the issue. `cancel` is its `cancel-in-progress: true`, and `queue` is its pending run that waits for the one in progress. `steer` has no Actions twin: an agent session can take a new message, and a CI job cannot. One value with three words reads simpler than a group plus a flag.

## A hub in the repo

The hub can live in the repo it works on, as `.bothub/` on the default branch. `BOTHUB_HUB` names it: a relative path, `.bothub` by default, is a folder in the repo, and an absolute path, such as the one `--hub <dir>` gives, is a folder on this machine. <!-- code: src/hub.ts#hubAt -->

A hub in the repo is read again at every look, always from the head of the default branch and never from a pull request's branch. A bot can propose a change to its own workflows, agents or checks, but the change counts only once a human merges it. The trust list is read once, when the runner starts. <!-- code: src/main.ts#start -->

## When the base or the hub moves

A run waiting at a `wait: human` step was checked against two things that can change under it: the head of its pull request's base, and the hub. Every sweep compares both with what is current.

If the branch is behind its base, for example `gh-pages` got new commits, the engine brings it up to date with no model. `follow` on the wait step says how: `merge` (the default) merges the base into the branch with a plain push, like GitHub's "Update branch" button, and leaves commits people pushed to the branch alone; `rebase` replays the branch onto the base and force-pushes, the same way it rebases a stacked branch. <!-- code: src/workflow.ts#Step -->

Then it compares the pull request's own change before and after, by `git patch-id`. When it is the same, only the wait step's `checks` run again. They default to the script checks of the step that `back` leads to, so finding out whether a pull request still holds costs no tokens. `checks: []` follows the base and checks nothing. A judged check in the list runs only once the scripts passed, and reads what moved on the base from `$BOTHUB_REPLY`; that is how a cheap agent can decide whether the pull request needs an update. When the change differs, or the hub changed since the run was last checked, every check of the step that `back` leads to runs, under the current hub. The hub's `setup` runs first, as in any new checkout. If the checks pass, the run keeps waiting. If they fail, the run goes back to that step as a request for changes would, with the failed checks as the reason. <!-- code: src/engine.ts#catchUp -->

A base that conflicts sends the run back to that step too, with the conflicting files as the reason. Its next try starts on the new base head with the change applied and conflict markers left in those files, and its push lands as one commit on the base (`rebase`) or as a merge of it (`merge`). The agent only edits files; the engine does the git. A try that leaves a conflict marker in the change fails. <!-- code: src/engine.ts#following --> If the run comes back to wait with the same base head still conflicting, that is said once on the issue, for a human to update by hand. A run that is up to date with both is left alone.

The hub's version is a hash of `hub.yaml`, the agents, skills, checks, workflows and scripts. Each run records the version it was last checked under. <!-- code: src/engine.ts#catchUp -->

## Status on the issue

The engine keeps one status comment on the issue up to date: the step and try, a link to the open question, why the run stopped, the cost so far, the pull request and any failing GitHub checks on it. It also keeps one status label: `bothub:working`, `bothub:waiting`, `bothub:done` or `bothub:stopped`. <!-- code: src/context.ts#shown -->

## Order and limits

Runs sort by priority label: `priority/high` first, then no label or `priority/medium`, then `priority/low`. Within a priority the older run goes first. At most `parallel` runs go at once. <!-- code: src/engine.ts#tick -->

A session that runs past `minutes` of wall-clock time ends, however steadily it prints, and a run that spends more than `usd-per-run` stops. These are the `limits` in `hub.yaml`. A runner error, such as a session that timed out, a provider that failed, a setup that broke or a check whose command is not found (exit 127), parks the run at its step with the error in the trace instead of stopping it, so a reply on the issue tries that step again with its tries and session kept. <!-- code: src/engine.ts#drive -->
