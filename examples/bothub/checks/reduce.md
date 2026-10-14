---
type: bot
description: Nothing the change adds is more than its Done-when rows need.
bot: reviewer
max-turns: 4
over:
  each: node "$BOTHUB_HUB/scripts/reduce.mjs"
  max: 1
mode: block
human: reduction pass, changes ran 2 to 2.7 times the reference change and 88 percent of the excess was tests; like a human telling the model to cut it down; blocks by ruling before any replay calibrated it
---
The item is the task, the Done-when rows and every line the change adds, each with its file and line.
Name added lines that can go without losing a row: a test no row names, a `still` test for code the
change does not touch, a fixture or helper used once, a branch for an input no producer emits, a
rule another module already decides.

FAIL listing each as `file:line`, with what to delete. PASS when nothing can go.

From attempt 2 on (the prompt says so), FAIL only on a whole test, function or file that can go. From
attempt 3 on, PASS and list the rest as notes. Without an attempt line in the prompt, this paragraph
does not apply.
