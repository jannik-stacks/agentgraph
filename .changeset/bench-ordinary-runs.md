---
'@jannik-stacks/agi': patch
---

Bench runs land in one store per set, `<set>/data/`, each try in its own attempt dir with a private tracker, and each arm passes its tracker as settings instead of process env. `bench/flatten.ts` moves an older set into this layout; `bench/migrate.ts` is gone.
