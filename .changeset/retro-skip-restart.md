---
'@jannik-stacks/agi': patch
---

A run stopped by `/agent:restart` starts no retro, since it goes on as a new run. `on: { feedback: { restarts: true } }` starts one anyway.
