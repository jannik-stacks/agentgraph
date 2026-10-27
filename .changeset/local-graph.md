---
'@jannik-stacks/agi': patch
---

A local instance reads an `.agentgraph/` that git does not track straight from disk, so a private graph can live in `.git/info/exclude`. `AGENTGRAPH_DIR` now picks the graph inside a repo too.
