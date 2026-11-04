---
'@jannik-stacks/agi': patch
---

Landed-run cleanup over a fetched mirror only considers branches with a checkout, so branches the next fetch restores are no longer removed and logged on every pass.
