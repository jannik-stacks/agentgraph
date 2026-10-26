---
mode: warn
each: node "$AGENTGRAPH_DIR/scripts/hunks.mjs" docs/
agent: checker
max: 10
---
A docs hunk states facts without selling them.

Are the lines this docs hunk adds plain statements of fact, free of praise, hype and selling words?
Pass if so; otherwise fail naming the words.
