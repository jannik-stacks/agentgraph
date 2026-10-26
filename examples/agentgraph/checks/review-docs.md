---
mode: warn
each: node "$AGENTGRAPH_DIR/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
Each docs hunk describes the code as it now behaves.

The item is one hunk of a docs page. Read the code it describes. Does every statement the hunk adds
hold against that code? Fail naming the statement and the code that contradicts it; otherwise
pass. Wording and tone are other checks' job.
