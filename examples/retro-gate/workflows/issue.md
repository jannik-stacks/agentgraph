---
on: { issues: { label: agent:ready } }
branch: agentgraph/{issue}
steps:
  implement: { agent: implementor }
  gate:
    run: node "$AGENTGRAPH_DIR/scripts/failed-tools.mjs" 5
  merge: { wait: human, back: implement }
---
One issue becomes one pull request. After the implementor opens it, the gate counts the tool calls
that failed in this run's trace. Past five, it starts the `retro` workflow on the same issue and the
run waits for it; when the retro is done the gate passes and the run moves on to the human merge.
