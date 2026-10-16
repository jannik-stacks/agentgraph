# The loop

A step is done when its checks pass, not when the agent says so.

```
event → run begins → step: session → checks → feedback to the same session → proposals applied → next step
```

## Workflows and steps

A workflow is a file in `workflows/`. Its `on:` names the events that start it, and its `steps`
run in the order written. The body is the description, or the prompt when the workflow has no steps.

```yaml
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  implement:
    bot: implementor
    tries: 3
    checks: [tests]
  review:
    bot: reviewer
    back: implement
    rounds: 2
    until: the change does what the issue asks and the tests cover it
  merge: { wait: human, back: implement }
```

A step is one of three kinds: `bot` names an agent, which gets the step's skill (the step's name
unless `skill` says otherwise), `run` is a script, and `wait: human` waits for a person. `branch` is
the branch a run works on, `{issue}` and `{parent}` filled in from the issue.

## Tries and checks

After an agent's session ends, each check in `checks` runs against the checkout. Script checks run
first, all at once. Agent checks run after them, and only when no `block` script check failed, so a
broken build never pays for a review.

| Mode    | Effect                                                                  |
| ------- | ----------------------------------------------------------------------- |
| `warn`  | Its failure is recorded and never holds the step                        |
| `block` | Its failure fails the try; its output goes back as feedback             |
| `stop`  | Its failure ends the run                                                |

A failed try starts another in the same session, and the prompt carries the feedback: each failing
check's output, and any proposal the engine refused. `tries` counts the first one. It defaults to 3
for a step with checks and 1 for one without. When the tries run out, the run waits and a comment
on the issue says why.

A check file is a script (`run`, exit 0 passes and the output is the feedback), an agent (`judge`,
which must start its reply with `PASS` or `FAIL`), or both: the script runs and its output goes to
the agent. `max` caps how many items a fan-out may take.

## Back

`back: implement` on a step sends the run to an earlier step. An agent step with `back` also needs
`until`, a sentence that says when the step is satisfied. The agent is told to make a `back`
proposal with a reason while that sentence does not hold, and the reason becomes the feedback of
the step it goes back to. `rounds` caps how many times, 3 by default. When they run out, the run
waits with the reason. Going forward into a step starts a fresh session; going back keeps the one
that step had.

A `wait: human` step with `back` goes back when a human asks for changes, with a `/bothub` comment or a
review requesting them. A review approval, an `approved` label or a merge passes it.

## Waiting

A run waits when an agent proposes `ask`, when tries or rounds run out, and at a `wait: human` step.
The engine posts the question on the issue. A human answers with `/bothub <answer>`, which becomes
feedback for the same step, or ends the run with `/bothub stop`. Closing the issue ends it too.
`node core/bin/run.ts status` lists what waits, with the command that continues each run.

## The prompt

A session starts with the agent's body as its system prompt. The prompt is the step's skill, the
workflow body, the issue and its comments, the branch to work on and where pull requests go, the
`until` sentence, any feedback, and the shape of every proposal the agent may make. The agent ends
its reply with a fenced `bothub` block of proposals, see [Proposals](proposals.md).

## Limits

`limits` in `hub.yaml` caps a run: `minutes` for one session or script, and `working`, how many runs
go at once. A session that runs past its minutes stops the run with the reason.
