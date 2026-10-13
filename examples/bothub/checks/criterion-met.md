---
type: bot
description: The change to src/, studio/src/ and the hub scripts meets each acceptance criterion, one criterion per run.
bot: reviewer
max-turns: 8
over:
  each: node "$BOTHUB_HUB/scripts/criteria.mjs"
  max: 5
paths: [src/**, studio/src/**, examples/bothub/scripts/**]
mode: warn
human: label id hole shipped twice in dogfood round 2, safety-checks item 2 and narrow-bots W1; design folded in, label id hole in dogfood round 2 run 2 review, safety-checks item 2 edge-cases judge; fails only on the criterion's own behaviour after the round 7 nitpick on Number() rounding; out of scope from dogfood round 6 (T4); reachable inputs only from dogfood x (X2); hub scripts from dogfood round 9 (T3); only the files its test names and 8 turns from the btc replay token review
---
The item is the task, one acceptance criterion, the test that proves it, the change to the files under
`src/`, `studio/src/` and `examples/bothub/scripts/` that its test file names, and what the brief leaves
out of scope. Judge from the item; read other code only for a path the change calls into and the item
does not show. Judge only the behaviour the criterion states.
Look for one concrete sequence of events within what the criterion and the task describe under which
the changed code does not do what the criterion says: an add, a remove, a re-add by a human through
the tracker, a restart, an empty or repeated input. Follow every code path that changes the state
the criterion is about, each changed function in full, and check each one keeps the invariant the
criterion needs.

FAIL only when the stated behaviour is missing or wrong, with that sequence and the line it goes
wrong on. The sequence must run through bothub's own inputs and documented use. A sequence that
needs a case listed under `out of scope`, a human hand-editing text bothub wrote (a marker in an
issue body, a stored file), malformed Unicode or other input crafted to break the code does not
count; neither does an input or case the criterion and the task do not mention, such as an unusual
number format, a limit nobody asked about or an older helper the change only calls. PASS and list
those after the verdict as notes. PASS when you cannot build a failing sequence from the code.
