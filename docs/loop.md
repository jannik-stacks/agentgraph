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

`checks: [tests]` names files in `checks/`, here `checks/tests.md`. A name that has no file is an error when the hub loads (`code: src/workflow.ts#load`).

A workflow without `steps` is one agent step named after the file, with the agent `agent` names.

`each` on an agent step opens one fresh session per item: `files` for each changed file, `hunks` for each diff hunk, or `{ run: <command> }` for each line the command prints. Such a step never resumes a session.

## Starting a run

Two triggers start runs today:

- `issue_comment` with `command`: a comment starting with that text, such as `/bothub`.
- `issues` with `label`: a label added to an issue, such as `triage`.

`pull_request` and `branches` are accepted but start nothing yet.

On GitHub, the main way in is to mention the bot. A comment counts when it has `@stx-bothub` as a word outside quoted lines and fenced code. `/bothub` works the same. The engine reads either as `/bothub` followed by the rest of the comment, so a bare mention starts the workflow too (`code: src/forge.ts#commanded`). On an issue with no live run, a mention that only says `stop` starts nothing.

Once the bot has a run on an issue, a trusted comment there speaks to it without a mention, unless it mentions someone else. Comments on the run's pull request count for its issue, and the bot's own comments never count.

A waiting run takes the comment as its answer. When every run there is finished, the comment starts the comment workflow, so a question like "where is the PR?" gets a reply.

A run started by a comment can reply and stop. When the comment asks for no work, the first session is told to reply with comments only, and that reply ends the run without checks or later steps.

The engine puts an eyes reaction on the comment that started or woke a run, or on the issue for a label, and takes it off once it has replied (`code: src/engine.ts#tick`).

The issue must be open, and one workflow runs at a time on it. Removing the label from an issue with a live run stops that run. A label added and removed before the engine looks starts nothing (`code: src/workflow.ts#reenter`).

## Trust and scope

Only trusted people steer the bot. By default those are the repo's owners, members and collaborators, and a label counts when its actor may write. Everyone else is an outsider: their comments and labels start nothing, and their text is withheld from agents.

`trust: [ana, bob]` in `hub.yaml` narrows that to those logins and the bot itself. A collaborator outside the list is then an outsider too. The runner reads the list when it starts, and a hub that does not load then trusts no one until a restart (`code: src/github.ts#githubForge`).

`milestone` in `hub.yaml` limits new runs to open issues in that milestone. Live runs keep going. Issues an agent files are not put in the milestone, so they wait until a person moves them in (`code: src/engine.ts#inScope`).

## The session

The agent's body goes into the session's system prompt. Claude Code and pi add it after their own default prompt. opencode uses it in place of its base prompt and still adds its environment, tools and skills.

The prompt holds the step's skill and the skills it `uses`, the workflow body, the issue and its comments, the pull request on the run's branch with its reviews, the branch to work on, the `until` sentence, any feedback, and the shape of every proposal the agent may make (`code: src/context.ts#context`). The agent ends its reply with a fenced `bothub` block of [proposals](proposals.md).

While the session works, the engine writes what is new on the issue and its pull request to a news file every minute. An agent with the `read` tool is told to read it before it finishes. A resumed session gets only the feedback and what is new (`code: src/context.ts#news`).

Each agent names its own harness and model, and the proxy gives each agent its own key. So every step and check can run on a different harness, model and provider (`code: src/hub.ts#Agent`).

## Checks

After a session ends, the step's checks run against the checkout. Script checks run first, all at once. Agent checks run only when no `block` or `stop` script check failed, so a broken build skips the review (`code: src/engine.ts#gate`).

| Mode    | When the check fails                               |
| ------- | -------------------------------------------------- |
| `warn`  | It is recorded and never holds the step            |
| `block` | The try fails and the output goes back as feedback |
| `stop`  | The run stops                                      |

A check file holds a script, an agent, or both:

- `run`: exit 0 passes, and the output is the feedback.
- `agent`: the reply must start with `PASS`. On its own the agent judges the diff, or the item in a fan-out.
- Both: the script runs and its output goes to the agent.

`each` fans a check out over `files`, `hunks`, or the lines a command prints, and the check fails when any item fails. When there are no items, the check passes marked `empty` with the finding "Judged nothing", so a slicer that lost its input shows up. More items than `max` fail the check.

Several agent checks on one step judge the same try side by side, each in a fresh session, and the findings of those that fail go back together. A reviewer never sees its own earlier verdict. The studio marks such a step with a chip naming the reviewers (`code: src/graph.ts#graphOf`).

```yaml
implement:
  agent: implementor
  checks: [tests, claude-review, gpt-review]
```

Scripts run with the checkout as their working directory and get these variables (`code: src/engine.ts#resultOf`):

| Variable           | What it holds                                                | Given to         |
| ------------------ | ------------------------------------------------------------ | ---------------- |
| `BOTHUB_BASE`      | The commit the checkout started from                         | checks and steps |
| `BOTHUB_HUB`       | The hub folder, read-only                                    | checks and steps |
| `BOTHUB_ISSUE`     | The issue number                                             | checks           |
| `BOTHUB_PROPOSALS` | A JSON file of the proposals the try made                    | checks           |
| `BOTHUB_CONTEXT`   | A file with the issue and pull request as the agent saw them | checks           |
| `BOTHUB_REPLY`     | A file with the try's reply                                  | checks           |
| `BOTHUB_ITEM`      | The item, in a fan-out                                       | checks           |

## Tries and going back

A failed try starts another in the same session, with each failing check's output and each failed proposal as feedback. `tries` counts the first one. When tries run out, the run waits and says why on the issue.

`back: implement` lets a step send the run to an earlier step. An agent step with `back` also needs `until`, a sentence saying when the step is satisfied. While it does not hold, the agent proposes `back` with a reason, and the reason becomes feedback for the earlier step. `rounds` caps how often that happens. When rounds run out, the run waits.

A `wait: human` step with `back` goes back when a human asks for changes in a comment or a review. An approving review, an `approved` label or a merge passes it.

Going forward into a step starts a fresh session. Going back resumes the session that step had (`code: src/workflow.ts#transition`).

## Waiting

A run waits when an agent proposes `ask`, when tries or rounds run out, and at a `wait: human` step. The engine posts the question as its own comment on the issue.

A human answers with a comment on the thread, or with `@stx-bothub <answer>`, and the answer becomes feedback for the same step. `@stx-bothub stop` ends a waiting run, and so does closing the issue. `node bin/run.ts status` lists what waits, with the command that continues each run (`code: src/status.ts#needsYou`).

## Status on the issue

The engine keeps one status comment on the issue up to date: the step and try, a link to the open question, why the run stopped, the cost so far, the pull request and any failing GitHub checks on it. It also keeps one status label: `bothub:working`, `bothub:waiting`, `bothub:done` or `bothub:stopped` (`code: src/context.ts#shown`).

## Order and limits

Runs sort by priority label: `priority/high` first, then no label or `priority/medium`, then `priority/low`. Within a priority the older run goes first (`code: src/engine.ts#tick`). At most `parallel` runs go at once.

A session that runs past `minutes` stops the run, and so does a run that spends more than `usd-per-run` (`code: src/engine.ts#drive`). These are the `limits` in `hub.yaml`.
