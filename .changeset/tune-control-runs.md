---
'@jannik-stacks/agi': patch
---

A tune now records each variant as a `tune` control run with its proposal, graph diff and decision, and labels its bench runs with `tune`, `variant` and `iteration`. The studio's Tunes view and `--tune` are gone; a tune shows through Runs and Results on its `data/`. `node tune/migrate.ts` moves older tune dirs.
