---
mode: warn
reads: traces
returns:
  type: object
  required: [usd, tools, steps, minutes, tokens]
  properties:
    usd: { type: number }
    tools: { type: integer }
    steps: { type: integer }
    minutes: { type: number }
    tokens: { type: integer }
pass: { properties: { tools: { maximum: 300 }, usd: { maximum: 2 } } }
run: node "$AGENTGRAPH_HUB/scripts/run-stats.mjs"
---
The run stayed under 300 tool calls and 2 dollars. It warns, so a run over budget is recorded and
goes on.
