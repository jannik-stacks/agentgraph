---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/tests.mjs" list
run: node "$AGENTGRAPH_HUB/scripts/tests.mjs" run "$AGENTGRAPH_ITEM"
---
Every test file the change touched passes on its own. The check records the share of those files
that pass, so a run that fixed four of five shows 0.8.
