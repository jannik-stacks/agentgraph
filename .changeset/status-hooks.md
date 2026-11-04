---
'@jannik-stacks/agi': patch
---

Plugins can declare an `on.status` hook that runs after the engine changes an issue's status label; on GitHub the hook context has `tracker.moveToColumn(issue, { project, name })`. A failing hook is logged and the run goes on.
