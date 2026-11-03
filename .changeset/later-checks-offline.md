---
'@jannik-stacks/agi': patch
---

`agi check --runs` scores a run's output without the forge: it reads the run's issue text, kept change and last reply, and never posts status. A check that does not apply to a run gets an empty result marked `na` instead of failing, and a check's version now includes its judge's harness and model.
