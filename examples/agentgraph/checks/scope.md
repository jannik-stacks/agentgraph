---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/scope.mjs"
agent: reviewer
max: 10
---
Each changed file the triage brief does not name still serves the task.

Does this file change serve the task, and stay clear of everything listed as out of scope? Pass if
so; otherwise fail saying what it does that the task does not need.
