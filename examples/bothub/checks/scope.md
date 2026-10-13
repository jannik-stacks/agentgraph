---
type: decide
description: Each changed file the triage brief does not name still serves the task.
over:
  each: node "$BOTHUB_HUB/scripts/scope.mjs"
  max: 20
threshold: 0.7
mode: shadow
human: six-angle dogfood review, narrow-bots W1 scope decide
---
Does this file change serve the task, and stay clear of everything listed as out of scope?
