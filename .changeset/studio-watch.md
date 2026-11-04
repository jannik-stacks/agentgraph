---
'@jannik-stacks/agi': patch
---

The studio no longer watches run checkouts, harness homes, caches or logs under its data, bench and tune folders, so it stays idle instead of burning CPU and reloading on every tsconfig change inside a run.
