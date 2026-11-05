---
'@jannik-stacks/agi': patch
---

`/agent:restart`, `/agent:stop` and `/agent:cancel` go to the issue's work run, not to a newer router run. A router run takes them only when the issue has no other run, or when they name it.
