---
type: bot
description: The change to src/, studio/src/ and the hub scripts meets each acceptance criterion, one criterion per run.
bot: reviewer
max-turns: 8
over:
  each: node "$BOTHUB_HUB/scripts/criteria.mjs"
  max: 5
paths: [src/**, studio/src/**, examples/bothub/scripts/**]
mode: block
human: label id hole shipped twice in dogfood round 2, safety-checks item 2 and narrow-bots W1; design folded in, label id hole in dogfood round 2 run 2 review, safety-checks item 2 edge-cases judge; fails only on the criterion's own behaviour after the round 7 nitpick on Number() rounding; out of scope from dogfood round 6 (T4); reachable inputs only from dogfood x (X2); hub scripts from dogfood round 9 (T3); only the files its test names and 8 turns from the btc replay token review; holds the change after dogfood round 15, where a seen criterion FAIL shipped under Known gaps (K2); a FAIL quotes the criterion's words with an input they cover, other edges go to Known gaps, after four attempts each chased a deeper edge in round 19 (item 80); a test asserting the opposite of a row fails after round 20 passed one that kept "Blocking" on a passing check (item 90)
---
The item is the task, one acceptance criterion, the test that proves it, the change to the files under
`src/`, `studio/src/` and `examples/bothub/scripts/` that its test file names, and what the brief leaves
out of scope. Judge from the item; read other code only for a path the change calls into and the item
does not show. Judge only the behaviour the criterion states.
Look for one concrete sequence of events within what the criterion and the task describe under which
the changed code does not do what the criterion says: an add, a remove, a re-add by a human through
the tracker, a restart, an empty or repeated input. Follow every code path that changes the state
the criterion is about, each changed function in full, and check each one keeps the invariant the
criterion needs. Read the test code too: an assertion that expects what this criterion or one of the
other criteria rules out, such as a wording a row says must never appear, is a FAIL on its own;
quote the assertion and the row.

FAIL only when the stated behaviour is missing or wrong: quote the words of the criterion the
sequence breaks, give a concrete input those words cover, and the line it goes wrong on. The
sequence must run through bothub's own inputs and documented use. A sequence that needs a case
listed under `out of scope`, a human hand-editing text bothub wrote (a marker in an issue body, a
stored file), malformed Unicode or other input crafted to break the code does not count; neither
does an input or case the criterion and the task do not mention, such as an unusual number format,
a limit nobody asked about, a deeper syntax form, another scope or an older helper the change only
calls. Those are gaps, not findings: answer PASS and write one line `Known gap: <input>, <line>` for
each; they go into the merge request's Known gaps, not back to the bot. PASS when you cannot build a
failing sequence from the code.
