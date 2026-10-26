---
mode: warn
reads: traces
returns:
  type: object
  required: [usd, tools, steps, minutes, tokens]
  properties:
    usd: { type: number, unit: usd, description: 'list price of every session of the run' }
    tools: { type: integer, description: 'tool calls across all sessions' }
    steps: { type: integer, description: 'step outcomes, so a retried step counts again' }
    minutes: { type: number, unit: minutes, description: 'from the first session event to the last step outcome' }
    tokens: { type: integer, unit: tokens, description: 'input and output tokens across all sessions, cached input included' }
pass: { properties: { tools: { maximum: 300 }, usd: { maximum: 2 } } }
run: node "$AGENTGRAPH_DIR/scripts/run-stats.mjs"
---
What the run spent, read from its trace. It passes under 300 tool calls and 2 dollars; it warns, so a run over budget
is recorded and goes on.
