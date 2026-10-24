# Compound engineering

A retro reads human feedback for recurring misses and proposes hub or docs changes, which people review and merge.

## The retro

`on: feedback` starts a retro on trusted comments, change requests, approvals with a comment, and commits people push where a run worked. Feedback on a pull request counts for its issue, also after it is merged or closed. A bare `/agent stop`, `/agent cancel` or `/agent restart` is not feedback. <!-- code: src/engine.ts#feedback -->

Feedback since the last retro is batched after 30 seconds of quiet and becomes the run's feedback. Feedback that arrives during a retro starts another one right away. <!-- code: src/engine.ts#tick -->

A retro never holds an issue, takes another run's answers or posts a status. It skips setup and stops where another workflow would wait. <!-- code: src/workflow.ts#transition -->

It ends with one of:

- Nothing, with a short reason, for taste, one-off wording or a call only a person can make.
- A [hub change](stacks.md#hub-changes) for a recurring miss that a check, lint, prompt or docs edit would prevent, with the kind of miss, run and trace evidence, and the smallest change.
- A [follow-up](stacks.md#follow-ups) for repo work nobody covered.

## Reading traces

`reads: traces` gives an agent a read-only `traces.md` beside its news file. It holds the issue's other runs, retros left out, oldest first: system prompts once per agent, session prompts, thinking, tool calls and results, replies, checks, proposals and outcomes. Entries keep their trace line numbers so the agent can cite them. <!-- code: src/context.ts#transcript -->

Long text is cut in the middle and secrets are redacted. Long sessions keep their first and last entries. Past about 60,000 characters, the oldest runs keep only session endings and outcomes.

Checks get the same file as `AGENTGRAPH_TRACES`, so a script can, for example, check that tests ran after the last edit. <!-- code: src/engine.ts#traced -->

## Super review

A judge that reads traces checks how the work was done. The `claims` check in `examples/acme-app` compares what the implementor says it did with its tool calls:

```yaml
# checks/claims.md
mode: warn
agent: auditor
---
Did the implementor do what its reply says it did?
```

Steps can read traces too. The studio marks both with "reads traces" and draws dashed edges from human steps to feedback workflows. <!-- code: src/graph.ts#makeWorkflowGraph -->
