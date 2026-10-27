---
on: { issues: { label: agent:ready, column: Agent Ready } }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
  merge: { wait: human, back: implement }
---
A maintainer adds the agent:ready label, or moves the issue's card into the Agent Ready column of a
board the repo owner owns. A run started from the board puts the label on the issue, so the label
always shows which issues the agents work on, and removing it stops the run.
