# Compound engineering

A retro examines human feedback for recurring misses and proposes hub or documentation changes. People review and merge those changes.

## The retro

`on: feedback` starts a retro on trusted comments, change-request reviews, approvals with comments, or commits pushed where another run worked. Pull request feedback counts for its issue after merge or closure too. Bare `/agent stop`, `/agent cancel` and `/agent restart` are excluded. <!-- code: src/engine.ts#feedback -->

New feedback since the previous retro is batched after 30 seconds of quiet. Its text becomes run feedback. Events arriving during a retro start another without waiting for it. <!-- code: src/engine.ts#tick -->

Retros never hold an issue, consume another run's answers or post status. They skip setup and stop wherever another workflow would wait. <!-- code: src/workflow.ts#transition -->

The retro chooses:

- Nothing, with a short reason, for taste, one-off wording or decisions requiring a person.
- A hub issue (`relation: hub`) for a recurring miss preventable by a check, lint, prompt or doc edit. Include the miss class, run/trace evidence and smallest change.
- A follow-up for uncovered repo work.

[Issue filing](stacks.md#follow-ups) handles duplicate titles and lists existing follow-up and hub issues for the agent.

## Reading traces

`reads: traces` gives an agent a read-only `traces.md` beside its news file and points to it in the prompt. It contains non-retro runs on that issue, oldest first: system prompts once per agent, session prompts, thinking, tool inputs/outputs, replies, checks, proposals and outcomes. Entries retain run trace line numbers for citations. <!-- code: src/context.ts#transcript -->

Long text is cut in the middle, secrets redacted, and long sessions keep first and last entries with an omitted count. Beyond about 60,000 characters, oldest runs retain only session endings and outcomes.

Checks receive the same file as `AGENTGRAPH_TRACES`; scripts can inspect it without a model, for example to check whether tests ran after the last edit. <!-- code: src/engine.ts#traced -->

## Super review

Trace-reading judges inspect how work was done. The sk hub's `claims` check compares an implementor's claims with its tool calls:

```yaml
# checks/claims.md
mode: warn
agent: auditor
---
Did the implementor do what its reply says it did?
```

Steps can read traces too. The studio marks both with "reads traces" and draws dashed edges from human steps to feedback workflows. <!-- code: src/graph.ts#graphOf -->
