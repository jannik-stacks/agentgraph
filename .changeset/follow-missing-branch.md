---
'@jannik-stacks/agi': patch
---

A stacked run whose branch was never pushed no longer parks with a rebase question when its parent moves. It takes the parent's new head as its base, and its next try starts its saved work there.
