---
type: bot
description: No new export in src/ repeats one that already exists.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/exports.mjs"
items: 10
paths: [src/**]
mode: warn
human: six-angle dogfood review, narrow-bots W1 dup judge; qwen3.5 passed every calibration export, smart separates all 8; one item per file, not per export, from dogfood x
---
The item is one file's new exports and the existing exports whose names share a word with one of
them. Does an existing export already do what a new one does? FAIL and name both, with the smallest
change that reuses it; otherwise PASS.
