---
'@jannik-stacks/agi': patch
---

A run can have no issue. The store's live reads (`get`, `list`) leave such runs out, so the loop, `show`, `resume`, `say` and traced context never see them; `getRecord` and `listRecords` return every run, and `check --runs` and results use them.
