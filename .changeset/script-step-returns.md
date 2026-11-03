---
'@jannik-stacks/agi': patch
---

A `run` step's printed proposals, `ask` and `back` included, are limited by its own `returns`, which defaults to `[run]`, so a repo command can no longer push, open a pull request, comment, ask or merge. A `merge` applies only from a step whose `returns` lists it, and `check:examples` reads CRLF graph files like the loader.
