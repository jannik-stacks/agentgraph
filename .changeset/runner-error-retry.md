---
'@jannik-stacks/agi': patch
---

A run parked by a runner error now tries its step again on its own: after 10 minutes, doubling with each try, at most 5 times. A reply still tries it at once.
