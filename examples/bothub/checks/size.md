---
type: script
description: The change adds at most 300 lines and touches at most 8 files outside tests/, not counting files that only make one rename.
run: node "$BOTHUB_HUB/scripts/size.mjs" 300 8
mode: block
---
A narrow task makes a small change. Tests don't count toward the cap, so a change is never pushed
to test less.

A file whose every changed line only swaps one word for another, the same swap across the change,
is a rename and does not count toward the file cap: a rename left half done is worse than a wide
one. Its lines still count.
