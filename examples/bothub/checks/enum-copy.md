---
type: script
description: No list the change adds copies every value of a string union the code declares, which would miss the next value the union gains.
run: node "$BOTHUB_HUB/scripts/enum-copy.mjs"
paths: [src/**, studio/src/**, examples/bothub/scripts/**]
mode: warn
human: the state-transitions slicer of dogfood round 9 copied the run statuses and closures and missed a new value, and a replay of that change flags both lists; over bothub's whole history it flags 2 lists, both real copies kept for their display order, so it warns
---
A union's values live where it is declared. Derive the list from the declaration, or read it from
there in a hub script, so a new value reaches every place that lists them.
