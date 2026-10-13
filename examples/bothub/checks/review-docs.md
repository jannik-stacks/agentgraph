---
type: bot
description: Each docs hunk describes the code as it now behaves.
bot: checker
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" studio/content/docs/
  max: 20
paths: [studio/content/docs/**]
mode: shadow
---
The item is one hunk of a docs page. Read the code it describes. Does every statement the hunk adds
hold against that code? FAIL naming the statement and the code that contradicts it; otherwise
PASS. Wording and tone are other checks' job.
