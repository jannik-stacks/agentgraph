---
mode: warn
each: node "$BOTHUB_HUB/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
A docs hunk adds no tagline after a dash at the end of a sentence.

Does every sentence this docs hunk adds end without a dash followed by a short tagline or punchline?
PASS if so; otherwise FAIL naming the sentence.
