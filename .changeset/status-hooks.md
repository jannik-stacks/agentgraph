---
'@jannik-stacks/agi': patch
---

Plugins can declare an `on.status` hook that runs after the engine changes an issue's status label. A failing hook is logged and the run goes on.
