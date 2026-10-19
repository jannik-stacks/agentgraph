---
title: Small judged checks answer without a bothub block
status: accepted
check: tests
human: dogfood round 2 kink K11
---
The `fast` model behind a judged check often answers `PASS` or `FAIL` as plain text and leaves out
a `bothub` block. The engine reads the final message and counts it as a pass when it starts with
that word. Keep it that way: a check that turns a clear `PASS` into "gave no verdict" fails the
change for the parser's sake, not the agent's.
