---
'@jannik-stacks/agi': patch
---

The Bench page is always shown and reads every served instance's runs plus the `--bench` sets, with labels as axes and check fields as columns. Operator-registered plugins can declare an `engine` hook that reads run stores and submits validated runs under their own name; graph plugin files that declare one are refused. `bench/graph-size.ts` now takes set dirs only.
