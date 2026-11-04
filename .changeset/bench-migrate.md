---
'@jannik-stacks/agi': patch
---

`node bench/migrate.ts <old bench dir> <set>` copies a bench dir in the earlier `diff.patch` and `score.json` layout into run slots. Its results are recorded at version `migrated`, and the old dir is left untouched.
