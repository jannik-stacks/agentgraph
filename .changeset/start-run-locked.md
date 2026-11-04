---
'@jannik-stacks/agi': patch
---

A new run stays locked until its first status and eyes reaction are saved, so another pass cannot drive or stop it in between. A dispatched run whose id is taken gets a fresh one, and when none frees up the dispatch fails instead of reporting a run that was never saved. Storage errors while starting a run now surface instead of starting nothing.
