---
type: bot
description: Each tooltip the change adds says what the thing is or does.
bot: checker
over:
  each: node "$BOTHUB_HUB/scripts/tooltips.mjs"
  max: 30
paths: [studio/src/**]
mode: log
human: mined from user dashboard feedback, feedback rule 7; qwen3.5 separates 7 of 8 calibration tooltips, so it logs until more tooltips confirm it
---
Does this tooltip tell a user, in plain words, what the element is or does, adding something the
visible label does not already say? PASS if so; otherwise FAIL with a better tooltip.
