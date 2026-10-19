# Compound engineering

Every review, comment or push a person makes where the bot worked can mean the bot missed something.
A retro asks, each time, how the bot could have avoided it, and turns the answer into a change to the
hub or the docs its agents read. Nothing changes until a person merges it.

```
 a person reviews, comments or pushes on the issue or pull request of a run
                      |
                      v
 the loop starts a run of the `on: feedback` workflow on that issue: a retro
                      |
                      v
 the retro agent (`reads: traces`) reads what was said and the traces of the runs on the issue
                      |
                      v
 it decides: nothing, a hub issue, or a follow-up
                      |
                      v
 a person works the hub issue like any other; once merged, the hub catches the miss next time
```

## The retro

A workflow with `on: feedback` starts on what a trusted person says or pushes where another run
worked: a comment, a review that requests changes or approves with a comment, or a commit pushed to the
run's branch. A comment that is only a command, such as `/bothub stop`, is not feedback. Comments on a
pull request count for the issue its branch worked on, also once it is merged or closed. <!-- code: src/engine.ts#feedback -->

What came in since the last retro on the issue starts one retro, once the issue has been quiet for 30
seconds. The run's feedback is the list of what was said or pushed. One retro works on an issue at a
time; what comes in meanwhile starts the next one. <!-- code: src/engine.ts#tick -->

A retro keeps out of the way of the run it looks at. It never holds the issue, never takes an answer
meant for another run, shows no status on the issue, skips the hub's `setup`, and never waits: where
another run would ask, it stops. <!-- code: src/workflow.ts#transition -->

A retro decides one of three:

- **nothing**, with one line of why. Most feedback lands here: taste, a one-off wording, a choice only a
  person could make.
- **a hub issue** (`"relation":"hub"`), when the same miss would come back and a check, a lint, a
  prompt line or a doc line would have caught it. Its body names the miss class, the evidence (run and
  trace lines) and the smallest change.
- **a follow-up**, when the feedback points at work in the repo that no issue covers.

A follow-up or hub issue with the title of an open one is added to it as a comment instead, and an
agent that may file issues sees the open follow-up and hub issues listed, so the same miss is not filed
twice. <!-- code: src/engine.ts#file -->

## Reading traces

An agent with `reads: traces` gets `traces.md` beside its news file, read-only, and its prompt says
where. It holds every run on the issue that is not a retro, oldest first: each agent's system prompt
once, then per session the prompt, thinking, tool calls with their input and output, and replies, then
the checks, applied proposals and outcomes. Each line starts with its line number in that run's trace,
so evidence can cite it. <!-- code: src/context.ts#transcript -->

Long text is cut in the middle, keys and tokens are redacted, a long session keeps its first and last
entries with a tally of the ones between, and past about 60,000 characters the oldest runs keep only
how their sessions ended and their outcomes.

Checks get the same file as `BOTHUB_TRACES`, so a script can grep it with no model, for example to see
whether a session ran the tests after its last edit. <!-- code: src/engine.ts#traced -->

## Super review

A check whose agent reads traces judges how the work was done, not only the change. The sk hub's
`claims` check has an auditor hold the implementor's reply to the tool calls its session made:

```yaml
# checks/claims.md
mode: warn
agent: auditor
---
Did the implementor do what its reply says it did?
```

A step whose agent reads traces works the same way. The studio marks both with "reads traces", and
draws a dashed edge from each workflow's human step to the workflows that start on feedback. <!-- code: src/graph.ts#graphOf -->
