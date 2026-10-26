---
on: { pull_request: { branches: ['agentgraph/*'] } }
steps:
  merge: { run: node "$AGENTGRAPH_DIR/scripts/merge-next.mjs", checks: [types, tests] }
---

Merges the oldest open request into a plan's branch once the types and tests checks pass on the
merged tree. Once every step of the plan is merged, it asks a human to merge the plan's branch.
