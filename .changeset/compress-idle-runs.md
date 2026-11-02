---
'@jannik-stacks/agi': patch
---

`loop` compresses the trace and check record of runs ended and untouched for `AGENTGRAPH_COMPRESS_DAYS` days (14) with zstd; every reader opens them as before.
