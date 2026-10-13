---
type: script
description: The change adds at most 300 lines and touches at most 8 files outside tests/.
run: node "$BOTHUB_HUB/scripts/size.mjs" 300 8
mode: block
---
A narrow task makes a small change. Tests don't count toward the cap, so a change is never pushed
to test less.
