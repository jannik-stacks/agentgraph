---
type: bot
description: Each changed file the triage brief does not name still serves the task.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/scope.mjs"
items: 10
mode: log
human: six-angle dogfood review, narrow-bots W1 scope decide; smart separates 7 of 8 calibration files, tev1 and qwen3.5 do not, so it logs until more files confirm it
---
Does this file change serve the task, and stay clear of everything listed as out of scope? PASS if
so; otherwise FAIL saying what it does that the task does not need.
