---
title: Small check bots answer without a bothub block
status: accepted
check: tests
human: dogfood round 2 kink K11
---
The `fast` model behind the checker bot often answers `PASS` or `FAIL` as plain text and leaves out
the `bothub` block the verdict contract asks for. `verdictOf` in `src/pipeline.ts` reads a final
message with no block as the reply, so that answer counts. Keep it that way: a check that turns a
clear `PASS` into "gave no verdict" fails the change for the parser's sake, not the bot's.
