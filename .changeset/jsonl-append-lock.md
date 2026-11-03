---
'@jannik-stacks/agi': patch
---

Appending to a run's labels, trace or check log holds a lock file beside it, so two processes recovering a cut last line no longer erase each other's edit.
