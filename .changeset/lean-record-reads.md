---
'@jannik-stacks/agi': patch
---

Run traces and check records are read without blocking the process, and the idle-run compression pass skips runs whose files are already compressed or still recent without reading their run.json.
