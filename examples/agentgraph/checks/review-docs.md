---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
Each docs hunk describes the code as it now behaves.

The item is one hunk of a docs page. Read the code it describes. Does every statement the hunk adds
hold against that code? FAIL naming the statement and the code that contradicts it; otherwise
PASS. Wording and tone are other checks' job.
