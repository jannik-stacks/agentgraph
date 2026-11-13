---
on: { issues: { label: agent:ready } }
branch: agentgraph/{issue}
steps:
  implement: { agent: implementor }
  gate:
    run: node "$AGENTGRAPH_DIR/scripts/failed-tools.mjs" 5
    reads: traces
  merge: { wait: human, back: implement }
---
One issue becomes one pull request. Past five failed tool calls, the gate starts the `retro` workflow.
