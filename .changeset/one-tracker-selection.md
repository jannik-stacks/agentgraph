---
'@jannik-stacks/agi': patch
---

The tracker is selected once (`--tracker`, else `AGENTGRAPH_TRACKER`, else `github` with the App env) for routing and `show`, and `agi check` says when the selection names nothing, names a plugin without a tracker, or needs a graph read from the repo.
