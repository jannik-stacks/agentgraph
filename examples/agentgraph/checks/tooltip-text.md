---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/tooltips.mjs"
agent: checker
max: 30
---
Each tooltip the change adds says what the thing is or does.

Does this tooltip tell a user, in plain words, what the element is or does, adding something the
visible label does not already say? Pass if so; otherwise fail with a better tooltip.
