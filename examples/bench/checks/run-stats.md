---
mode: info
reads: traces
returns:
  type: object
  required: [usd, tools, steps, minutes, tokens]
  properties:
    usd: { type: number, description: 'dollars every session of the run spent' }
    tools: { type: integer, description: 'tool calls across all sessions' }
    steps: { type: integer, description: 'step outcomes, so a retried step counts again' }
    minutes: { type: number, description: 'from the first session event to the last step outcome' }
    tokens: { type: integer, description: 'input, output and cached tokens across all sessions' }
run: node "$AGENTGRAPH_HUB/scripts/run-stats.mjs"
---
What the run spent, read from its trace. It never fails; the studio compares it across runs and arms.
