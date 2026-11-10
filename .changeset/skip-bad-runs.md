---
'@jannik-stacks/agi': patch
---

Listing runs skips a `run.json` that does not decode and logs its file and reason, and the studio leaves out a run whose trace or checks do not decode, so one bad record no longer fails the whole list. Reading a single run still fails on it.
