---
type: bot
description: No new export in src/ repeats one that already exists.
bot: checker
over:
  each: node "$BOTHUB_HUB/scripts/exports.mjs"
  max: 20
paths: [src/**]
mode: shadow
human: six-angle dogfood review, narrow-bots W1 dup judge
---
The item is one export this change adds and the existing exports whose names share a word with it.
Does one of those existing exports already do what the new one does? FAIL and name it, with the
smallest change that reuses it; otherwise PASS.
