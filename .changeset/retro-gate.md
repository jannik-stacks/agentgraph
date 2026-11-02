---
'@jannik-stacks/agi': patch
---

`run` steps get the issue number and the run's traces, so a step can gate on how the run went. `examples/retro-gate` starts a retro after more than five failed tool calls.
