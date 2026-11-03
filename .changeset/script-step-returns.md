---
'@jannik-stacks/agi': patch
---

A `run` step's printed proposals are limited by its own `returns`, which defaults to `[run]`, so a repo command can no longer push, open a pull request, comment or merge. A `merge` applies only from a step whose `returns` lists it.
