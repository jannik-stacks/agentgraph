---
type: bot
description: No new export in src/ repeats one that already exists.
bot: reviewer
over:
  each: node "$BOTHUB_HUB/scripts/exports.mjs"
  max: 10
paths: [src/**]
mode: warn
human: six-angle dogfood review, narrow-bots W1 dup judge; qwen3.5 passed every calibration export, smart separates all 8
---
The item is one export this change adds and the existing exports whose names share a word with it.
Does one of those existing exports already do what the new one does? FAIL and name it, with the
smallest change that reuses it; otherwise PASS.
