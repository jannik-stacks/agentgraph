---
'@jannik-stacks/agi': patch
---

The bench driver reads its keys once before it checks every queued point, so proxy keys given only in the shell reach each point.
