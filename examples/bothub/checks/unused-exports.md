---
type: script
description: Everything the change adds is wired in, every new export used by another file, every new file imported outside tests, every new optional field set and every new event type read outside tests.
run: node "$BOTHUB_HUB/scripts/unused-exports.mjs"
paths: [src/**, studio/src/**]
mode: block
human: mined from user feedback, feedback rule 3; new files (X9) and the seam pairing misses (fields nothing sets, events nothing reads) from dogfood x, gating since it reports only what the change adds
---
Code nobody calls is code nobody needs yet. Wire it into the code that needs it, or drop it.
