---
'@jannik-stacks/agi': patch
---

`bench run` labels every run it starts (case, arm, harness, model, repeat, engine, set) and the driver finds finished jobs by those labels instead of `done/` markers. Judging writes `judge/panel.json`.
