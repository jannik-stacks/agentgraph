---
'@jannik-stacks/agi': patch
---

`agi say`, `review`, `close` and `merge` write the tracker folder under the same lock as a running loop, so neither loses the other's change.
