---
'@jannik-stacks/agi': patch
---

`bench run` labels every run it starts (case, arm, harness, model, repeat, engine, set) and the driver finds finished jobs by their scores and `judge/panel.json` instead of `done/` markers. A reused cached arm takes the new invocation's labels.
