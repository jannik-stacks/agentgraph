---
'@jannik-stacks/agi': patch
---

A run waiting on a run it started, or parked on an engine error, now records that in a `waiting` field instead of in its reason text.
