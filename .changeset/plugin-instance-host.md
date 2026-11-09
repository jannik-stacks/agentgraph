---
'@jannik-stacks/agi': patch
---

Studio page readers get a host scoped to their instance, with the store and tracker reads the studio's own pages use and its `actions`. Pages call `say` and `label` through `runAction`, the same functions as the CLI verbs; a studio over a tracker folder now posts like `agi say`.
