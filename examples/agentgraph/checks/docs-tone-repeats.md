---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
A docs hunk says each thing once.

Does each sentence this docs hunk adds say something that no sentence before it in the hunk already
says? Pass if so; otherwise fail naming both sentences.
