---
'@jannik-stacks/agi': patch
---

`agi loop` serves several instances in one process: repeat `--instance`, or run it outside a repo to serve every instance with `loop: true`. Each keeps its own graph, data, lock, tracker, settings and session permits; one that fails stops alone. `--parallel <n>` caps drives across all of them, and SIGINT or SIGTERM releases every lock.
