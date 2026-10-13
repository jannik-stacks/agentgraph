---
type: decide
description: Each tooltip the change adds says what the thing is or does.
over:
  each: node "$BOTHUB_HUB/scripts/tooltips.mjs"
  max: 30
paths: [studio/src/**]
threshold: 0.7
mode: shadow
human: mined from user dashboard feedback, feedback rule 7
---
Does this tooltip tell a user, in plain words, what the element is or does, adding something the
visible label does not already say?
