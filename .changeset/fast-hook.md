---
'@jannik-stacks/agi': patch
---

The commit hook runs `npm run check:fast`: the static checks and only the tests related to the change. `npm run check` runs the tests alongside the other checks and stays the gate before a merge.
