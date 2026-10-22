---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
A docs hunk says what agentgraph does, not where an idea came from.

Do the lines this docs hunk adds describe what agentgraph does, without saying who decided it, when, or
where the idea came from? PASS if so; otherwise FAIL naming the line.
