---
'@jannik-stacks/agi': patch
---

When an instance's tracker folder is missing, the CLI and the studio now say which folder is missing and exit, instead of the studio dying with `spawn git ENOENT`.
