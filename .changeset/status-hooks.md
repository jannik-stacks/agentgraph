---
'@jannik-stacks/agi': patch
---

Plugins can declare an `on.status` hook that runs after the engine changes an issue's status label; on GitHub the hook context has `tracker.writeField(issue, { project, field, value })`, which sets or, with `null`, clears a single-select field of the issue's card on a project board. A failing hook is logged and the run goes on.
