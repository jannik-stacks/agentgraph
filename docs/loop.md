# The loop

A step is done when its checks pass.

```
event → run begins → step: session → checks → feedback to the same session → proposals applied → next step
```

## Triggers

`on:` in a workflow file names what starts a run. Two forms start runs today:

- `issue_comment` with `command`: a comment starting with that text, such as `/bothub`.
- `issues` with `label`: a label being added to an issue, such as `triage`.

Only a collaborator's comment or label starts a run. An outsider's comment or label is ignored, and their text is withheld from agents.

The issue must be open. One workflow runs once at a time on an issue. Adding a label and removing it before the engine looks starts nothing.

On a new run, the engine reacts to the comment with an eyes reaction so people can see it was heard. It removes the reaction once it has replied. The run then keeps its own state. Later comments on a waiting run answer it. See [Waiting](loop.md#waiting).

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

`branch` is the branch a run works on, with `{issue}` and `{parent}` filled in from the issue. `base` is the branch its pull requests go into. It defaults to `main`.

## Tries and checks

After an agent's session ends, each check in the step's `checks` runs against the checkout.

Script checks run first, all at once. Agent checks run after them, only when no `block` script check failed. A broken build skips the review.

| Mode    | Effect                                                                  |
| ------- | ----------------------------------------------------------------------- |
| `warn`  | Its failure is recorded and never holds the step                        |
| `block` | Its failure fails the try; its output goes back as feedback             |
| `stop`  | Its failure ends the run                                                |

A failed try starts another in the same session. The prompt carries each failing check's output and any proposal that failed as feedback.

`tries` counts the first one. It defaults to 3 for a step with checks and 1 for a step without. When tries run out, the run waits and a comment on the issue says why.

A check file can be a script, an agent, or both:

- A script uses `run`. Exit 0 passes, and the output is the feedback.
- An agent uses `agent`. Its reply must start with `PASS` or `FAIL`.
- With both, the script runs and its output goes to the agent.

`max` caps how many items a fan-out may take.

## Back

`back: implement` on a step sends the run to an earlier step.

An agent step with `back` also needs `until`, a sentence saying when the step is satisfied. While that sentence does not hold, the agent is told to make a `back` proposal with a reason. The reason becomes feedback for the step the run goes back to.

`rounds` caps how many times a step may go back. It defaults to 3 for an agent step; a `wait: human` step has no cap. When rounds run out, the run waits with the reason.

Going forward into a step starts a fresh session. Going back keeps the session that step had.

A `wait: human` step with `back` goes back when a human asks for changes with a `/bothub` comment or a review requesting changes. A review approval, an `approved` label or a merge passes it.

## Waiting

A run waits when an agent proposes `ask`, when tries or rounds run out, and at a `wait: human` step. The engine posts the question on the issue.

A human answers with `/bothub <answer>`, which becomes feedback for the same step. `/bothub stop` ends the run. Closing the issue ends it too.

`node bin/run.ts status` lists what waits, with the command that continues each run.

## The prompt

A session starts with the agent's body as its system prompt.

The prompt includes the step's skill, the workflow body, the issue and its comments, the branch to work on and where pull requests go, the `until` sentence, any feedback, and the shape of every proposal the agent may make.

The agent ends its reply with a fenced `bothub` block of proposals. See [Proposals](proposals.md).

## Limits

`limits` in `hub.yaml` caps a run:

- `minutes` limits one session or script. It defaults to 30.
- `usd-per-run` limits the run's spend. It defaults to 10.
- `parallel` limits how many runs go at once. It defaults to 2.

A session that runs past its minutes stops the run with the reason.
