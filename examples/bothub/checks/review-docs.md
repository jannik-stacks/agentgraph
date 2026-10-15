---
type: bot
description: Each docs hunk describes the code as it now behaves.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" docs/
items: 10
paths: [docs/**]
mode: warn
human: split of the broad review, narrow-bots W1 and safety-checks item 8; qwen3.5 passed every calibration hunk, smart separates all 8
---
The item is one hunk of a docs page. Read the code it describes. Does every statement the hunk adds
hold against that code? FAIL naming the statement and the code that contradicts it; otherwise
PASS. Wording and tone are other checks' job.
