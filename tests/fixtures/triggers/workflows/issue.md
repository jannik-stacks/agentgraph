---
on: { issues: { label: agent:ready, column: Agent Ready } }
branch: agentgraph/{issue}
steps:
  implement: { agent: implementor }
  merge: { wait: human, back: implement }
---
The agent:ready label, or the Agent Ready column of a board the repo owner owns, starts a run.
