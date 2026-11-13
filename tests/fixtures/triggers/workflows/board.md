---
on: { issues: { column: Agent Ready, project: acme/1 } }
branch: agentgraph/{issue}
steps:
  implement: { agent: implementor }
  merge: { wait: human, back: implement }
---
Moving an issue's card into the Agent Ready column of the project board starts a run.
