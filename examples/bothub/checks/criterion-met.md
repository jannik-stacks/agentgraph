---
type: bot
description: The change to src/ and studio/src/ meets each acceptance criterion, one criterion per run.
bot: reviewer
over:
  each: node "$BOTHUB_HUB/scripts/criteria.mjs"
  max: 5
paths: [src/**, studio/src/**]
mode: warn
human: label id hole shipped twice in dogfood round 2, safety-checks item 2 and narrow-bots W1
---
The item is the task, one acceptance criterion, the test that proves it and the change to `src/`
and `studio/src/`. Look for one concrete sequence of events under which the changed code breaks
this criterion: an add, a remove, a re-add, a restart, a hand edit, an empty or repeated input.
FAIL with that sequence and the line it goes wrong on. PASS when you cannot build one from the
code.
