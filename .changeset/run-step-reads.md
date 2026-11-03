---
'@jannik-stacks/agi': patch
---

A `run` step gets `AGENTGRAPH_TRACES` and `AGENTGRAPH_RUN_TRACE` only with `reads: traces`, so a step that does not read them no longer reads every run on its issue on each try. The retro-gate example opts in.
