---
'@jannik-stacks/agi': patch
---

A run started by `/agent` now gets every trusted comment since the last run of its workflow looked, in full, as its request, so a request written before a bare `/agent` or just after it is not cut short.
