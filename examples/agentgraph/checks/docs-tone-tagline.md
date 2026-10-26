---
mode: warn
each: node "$AGENTGRAPH_DIR/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
A docs hunk adds no tagline after a dash at the end of a sentence.

Does every sentence this docs hunk adds end without a dash followed by a short tagline or punchline?
Pass if so; otherwise fail naming the sentence.
