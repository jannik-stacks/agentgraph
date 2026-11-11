---
'@jannik-stacks/agi': patch
---

Under the `AGENTGRAPH_MIN_FREE_GB` floor (40) the engine now warns once with free space, the floor and the settings, and keeps working; `AGENTGRAPH_DISK_LOW=block` restores waiting. Low-disk cleanup never removes the sandbox setup image the current work just built or needs.
