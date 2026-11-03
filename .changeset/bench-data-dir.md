---
'@jannik-stacks/agi': patch
---

A bench run's trace keeps its data dir for full logs, results and links, and the studio serves a data dir only when its real path, after symlinks, is inside a bench dir.
