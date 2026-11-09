---
'@jannik-stacks/agi': patch
---

Every attempt's files are committed at `refs/agentgraph/attempts/<run id>/<n>`, so a retry never overwrites an earlier try. The engine now saves a dead engine process's checkout at `refs/agentgraph/reaped/<id>` before removing it, and keeps it when the save fails.
