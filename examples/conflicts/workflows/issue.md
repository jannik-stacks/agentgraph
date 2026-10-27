---
on: { issues: { label: agent:ready } }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
  merge: { wait: human, back: implement }
---
One issue becomes one pull request that waits for a human to merge. When the base moves and the
change conflicts with it, this run keeps waiting and the conflict workflow resolves it.
