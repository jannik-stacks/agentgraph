# The loop

A step is done when its checks pass.

```
event → run begins → step: session → checks → feedback to the same session → proposals applied → next step
```

## Triggers

`on:` in a workflow file names what starts a run. Two forms start runs today:

- `issue_comment` with `command`: a comment starting with that text, such as `/bothub`.
- `issues` with `label`: a label being added to an issue, such as `triage`.

On GitHub, mentioning the bot is the main way to talk to it: a comment counts when it says `@` and the App's name (`@stx-bothub`) as a word anywhere outside quoted lines and fenced code, because mentions autocomplete and slash commands do not. `/bothub` works the same as a fallback. The engine reads either as `/bothub` followed by the rest of the comment (`code: src/forge.ts#commanded`). A bare mention with no words starts the workflow too. On an issue with no live run a mention that only says `stop` starts nothing.

`pull_request` and `branches` are accepted in `on:` but start nothing yet.

Only a collaborator with write access starts a run. An outsider's comment or label is ignored, and their text is withheld from agents.

The issue must be open. One workflow runs once at a time on an issue. Adding a label and removing it before the engine looks starts nothing. Removing the label from an issue with a live run stops that run (`code: src/workflow.ts#reenter`).

The engine reacts with an eyes emoji to the comment that started or woke a run, or to the issue for a label, so people can see it was heard, and removes it once it has replied. The run then keeps its own state. Later comments on a waiting run answer it. See [Waiting](loop.md#waiting) (`code: src/engine.ts#tick`).

## Workflows and steps

A workflow is a file in `workflows/`. Its `on:` names the events that start it. Its `steps` run in the order written. The body is the description, or the prompt when the workflow has no steps.

```yaml
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
    checks: [tests]
  review:
    agent: reviewer
    back: implement
    rounds: 2
    until: the change does what the issue asks and the tests cover it
  merge: { wait: human, back: implement }
```

A step is one of three kinds:

- `agent` names an agent. It gets the step's skill: the step's name unless `skill` says otherwise.
- `run` is a script.
- `wait: human` waits for a person.

A workflow without `steps` is one agent step named after the file. It names its agent with `agent`, which may be left out when the hub has only one agent.

`each` on an agent step opens one fresh session per item: `files` for each changed file, `hunks` for each diff hunk, or `{ run: <command> }` for each line the command prints. Such a step does not resume sessions on a retry.

`branch` is the branch a run works on, with `{issue}` and `{parent}` filled in from the issue. `base` is the branch its pull requests go into. It defaults to `main` (`code: src/workflow.ts#load`).

## Tries and checks

After an agent's session ends, each check in the step's `checks` runs against the checkout.

Script checks run first, all at once. Agent checks run after them, only when no `block` or `stop` script check failed. A broken build skips the review (`code: src/engine.ts#gate`).

Every check names its `mode`:

| Mode    | Effect                                                                  |
| ------- | ----------------------------------------------------------------------- |
| `warn`  | Its failure is recorded and never holds the step                        |
| `block` | Its failure fails the try; its output goes back as feedback             |
| `stop`  | Its failure ends the run                                                |

A failed try starts another in the same session. The prompt carries each failing check's output and any proposal that failed as feedback.

`tries` counts the first one. It defaults to 3 for a step with checks and 1 for a step without. When tries run out, the run waits and a comment on the issue says why.

A check file can be a script, an agent, or both:

- A script uses `run`. Exit 0 passes, and the output is the feedback.
- An agent uses `agent`. Its reply must start with `PASS`; anything else fails. On its own it judges the diff, or the item in a fan-out.
- With both, the script runs and its output goes to the agent.

`each` fans a check out over items, in the same three forms as a step: `files`, `hunks`, or a command that prints one item per line. The check fails when any item fails. `max` caps how many items it may take; more fails the check.

A check's script gets `BOTHUB_BASE` (the commit the checkout started from), `BOTHUB_PROPOSALS` (a JSON file of the proposals the try made), `BOTHUB_ITEM` (the item, in a fan-out) and `BOTHUB_HUB` (the hub folder, read-only). A step's `run` script gets `BOTHUB_BASE` and `BOTHUB_HUB`. Scripts run with the checkout as their working directory (`code: src/engine.ts#resultOf`).

## Back

`back: implement` on a step sends the run to an earlier step.

An agent step with `back` also needs `until`, a sentence saying when the step is satisfied. While that sentence does not hold, the agent is told to make a `back` proposal with a reason. The reason becomes feedback for the step the run goes back to.

`rounds` caps how many times a step may go back. It defaults to 3; a `wait: human` step has no cap. When rounds run out, the run waits with the reason.

Going forward into a step starts a fresh session. Going back keeps the session that step had (`code: src/workflow.ts#transition`).

A `wait: human` step with `back` goes back when a human asks for changes by mentioning the bot or a review requesting changes. A review approval, an `approved` label or a merge passes it.

## Several models

Each agent file names its own harness and model, and the proxy gives each agent its own key. So every step and every check can run on a different harness, model and provider (`code: src/hub.ts#Agent`).

Two checks with agents on one step review the same try side by side, each in its own session. The findings of those that fail go back together. Here a Claude Code reviewer and an opencode reviewer judge one implementor's work:

```yaml
steps:
  implement:
    agent: implementor
    checks: [tests, claude-review, gpt-review]
```

Agents talk in rounds through feedback. A check's verdict goes into the implementor's session on its next try, and a step with `back` sends its reason to an earlier step. The implementor keeps its session across rounds. A reviewer starts fresh every time, so it judges the work rather than its own earlier verdict (`code: src/engine.ts#gate`).

The studio marks a step with more than one reviewing agent with a chip that names them (`code: src/graph.ts#graphOf`).

## Waiting

A run waits when an agent proposes `ask`, when tries or rounds run out, and at a `wait: human` step. The engine posts the question on the issue.

A human answers by mentioning the bot, `@stx-bothub <answer>`, which becomes feedback for the same step. `@stx-bothub stop` ends a waiting run. The question is its own comment, kept as the record; the status comment points at it and carries that instruction; `/bothub` works in place of the mention. Closing the issue ends it too.

`node bin/run.ts status` lists what waits, with the command that continues each run (`code: src/status.ts#needsYou`).

## Status on the issue

The engine keeps one status comment on the issue up to date: the step and try it is on, a pointer to the question it waits on, why it stopped, the cost so far, the pull request and any failing GitHub checks on it.

It also keeps one status label on the issue: `bothub:working`, `bothub:waiting`, `bothub:done` or `bothub:stopped` (`code: src/context.ts#shown`).

## The prompt

A session starts with the agent's body in its system prompt. Claude Code and pi add the body after their own default prompt. opencode uses the body in place of its base prompt and still adds its environment block, tool definitions and skills.

The prompt includes the step's skill, the workflow body, the issue and its comments, the pull request on the run's branch with its reviews, the branch to work on and where pull requests go, the `until` sentence, any feedback, and the shape of every proposal the agent may make (`code: src/context.ts#context`).

While the session works, the engine writes what is new on the issue and its pull request to a news file every minute, and the prompt tells the agent to read it before it finishes. A resumed session gets only the feedback and what is new (`code: src/context.ts#news`).

The agent ends its reply with a fenced `bothub` block of proposals. See [Proposals](proposals.md).

## Limits

`limits` in `hub.yaml` caps a run:

- `minutes` limits one session or script. It defaults to 30.
- `usd-per-run` limits the run's spend. It defaults to 10.
- `parallel` limits how many runs go at once. It defaults to 2.

A session that runs past its minutes stops the run with the reason. So does a run whose spend goes over `usd-per-run` (`code: src/engine.ts#drive`).

## Scope and trust

`trust` in `hub.yaml` lists the logins that may steer the bot, for example `trust: [ana, bob]`. When it is set, only those logins and the bot itself count as trusted: their issue and comment text reaches agents, their comments and replies start or answer runs, and their labels start runs. Everyone else is treated as an outsider, even a collaborator or an org member, so a collaborator outside the list cannot start work by labelling. Without it, owners, members and collaborators are trusted, and a label counts when its actor may write. The list is read once when the runner starts. A hub that does not load at that point trusts no one until the runner restarts. The forge folder honors the list by the author or actor login (`code: src/github.ts#githubForge`).

`milestone` in `hub.yaml` names a milestone by its title. While it is set, only open issues in that milestone start runs, whether by a label, a command or a sweep. Runs already live keep going. Follow-up issues an agent files are not put in the milestone, so they wait until a person moves them in. Without it, every open issue can start a run (`code: src/engine.ts#inScope`).
