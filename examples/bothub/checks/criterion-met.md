---
type: bot
description: The change to src/ and studio/src/ meets each acceptance criterion, one criterion per run.
bot: reviewer
over:
  each: node "$BOTHUB_HUB/scripts/criteria.mjs"
  max: 5
paths: [src/**, studio/src/**]
mode: warn
human: label id hole shipped twice in dogfood round 2, safety-checks item 2 and narrow-bots W1; design folded in, label id hole in dogfood round 2 run 2 review, safety-checks item 2 edge-cases judge; fails only on the criterion's own behaviour after the round 7 nitpick on Number() rounding
---
The item is the task, one acceptance criterion, the test that proves it and the change to `src/`
and `studio/src/`. Judge only the behaviour the criterion states. Look for one concrete sequence
of events within what the criterion and the task describe under which the changed code does not
do what the criterion says: an add, a remove, a re-add, a restart, a hand edit, an empty or
repeated input. Follow every code path that changes the state the criterion is about, each
changed function in full, and check each one keeps the invariant the criterion needs.

FAIL only when the stated behaviour is missing or wrong, with that sequence and the line it goes
wrong on. An input or case the criterion and the task do not mention, such as an unusual number
format, a limit nobody asked about or an older helper the change only calls, is not a reason to
fail: PASS and list it after the verdict as a note. PASS when you cannot build a failing
sequence from the code.
