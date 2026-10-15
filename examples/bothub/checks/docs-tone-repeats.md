---
type: bot
description: A docs hunk says each thing once.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" studio/content/docs/
items: 10
paths: [studio/content/docs/**]
mode: warn
human: one question per check, safety-checks item 10 split of docs-tone; smart separates all 8 calibration hunks
---
Does each sentence this docs hunk adds say something that no sentence before it in the hunk already
says? PASS if so; otherwise FAIL naming both sentences.
