---
on: { issues: { column: Agent Ready, project: jannik-stacks/1 } }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
  merge: { wait: human, back: implement }
---
Moving an issue's card into the Agent Ready column of the project board starts a run. The run ends in a
pull request that waits for a human to merge.
