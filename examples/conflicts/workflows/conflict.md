---
on: conflict
branch: agentgraph/{issue}
steps:
  resolve:
    agent: resolver
---
Starts when the pull request of a run waiting on a human conflicts with its moved base. The work
tree starts on the new base with the change applied and conflict markers left. The resolver removes
them and pushes, on a budget of its own, while the first run keeps waiting.
