---
type: bot
description: A docs hunk says what bothub does, not where an idea came from.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" studio/content/docs/
items: 10
paths: [studio/content/docs/**]
mode: warn
human: one question per check, safety-checks item 10 split of docs-tone; smart separates all 8 calibration hunks
---
Do the lines this docs hunk adds describe what bothub does, without saying who decided it, when, or
where the idea came from? PASS if so; otherwise FAIL naming the line.
