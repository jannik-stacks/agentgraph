---
'@jannik-stacks/agi': patch
---

`limits.parallel` and `agi loop --parallel` now cap sandbox commands (scripts, check commands, setups, checkouts) instead of whole drives, so a run waiting on a model no longer holds a slot. `limits.sessions` caps sessions and judges; its default drops from 4 to 2. A freed slot goes to the run furthest along its workflow, then to the one started first.
