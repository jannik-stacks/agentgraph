---
type: script
description: The change adds at most the lines and changes at most the files outside tests/ that scripts/bounds.mjs allows. Only files that add or change lines count toward the file cap, so a file that only deletes lines does not, and neither does a file that only makes the change's one rename.
run: node "$BOTHUB_HUB/scripts/size.mjs"
mode: block
human: size caps, six-angle dogfood review, safety-checks item 9, rename exemption dogfood round 2 kink K7, deletion-only files left out, dogfood round 5, K22
---
