---
mode: warn
each: node "$BOTHUB_HUB/scripts/exports.mjs"
agent: reviewer
max: 10
---
No new export in src/ repeats one that already exists.

The item is one file's new exports and the existing exports whose names share a word with one of
them. Does an existing export already do what a new one does? FAIL and name both, with the smallest
change that reuses it; otherwise PASS.
