---
'@jannik-stacks/agi': patch
---

An instance's `tracker` now beats `AGENTGRAPH_TRACKER` and the App env, so App variables meant for one instance of a loop never move another onto the github tracker. `--tracker` still wins.
