---
'@jannik-stacks/agi': patch
---

A run whose issue stacks on nothing no longer looks up a stack base, so it never lands on an open pull request from a branch named `agentgraph/undefined`.
