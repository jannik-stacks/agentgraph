---
on: conflict
branch: agentgraph/{issue}
steps:
  resolve:
    agent: resolver
---
Resolves the conflict of a run waiting on a human with its moved base, while that run keeps waiting.
