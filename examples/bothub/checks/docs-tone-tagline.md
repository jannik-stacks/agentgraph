---
type: bot
description: A docs hunk adds no tagline after a dash at the end of a sentence.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" studio/content/docs/
items: 10
paths: [studio/content/docs/**]
mode: log
human: one question per check, safety-checks item 10 split of docs-tone; smart separates 7 of 8 calibration hunks, tev1 and qwen3.5 do not, so it logs until more hunks confirm it
---
Does every sentence this docs hunk adds end without a dash followed by a short tagline or punchline?
PASS if so; otherwise FAIL naming the sentence.
