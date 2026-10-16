---
mode: warn
each: node "$BOTHUB_HUB/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
A docs hunk says each thing once.

Does each sentence this docs hunk adds say something that no sentence before it in the hunk already
says? PASS if so; otherwise FAIL naming both sentences.
