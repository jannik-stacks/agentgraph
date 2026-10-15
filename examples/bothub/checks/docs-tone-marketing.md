---
type: bot
description: A docs hunk states facts without selling them.
bot: checker
minutes: 5
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" docs/
items: 10
paths: [docs/**]
mode: log
human: one question per check, safety-checks item 10 split of docs-tone; qwen3.5 separates 7 of 8 calibration hunks, so it logs until more hunks confirm it
---
Are the lines this docs hunk adds plain statements of fact, free of praise, hype and selling words?
PASS if so; otherwise FAIL naming the words.
