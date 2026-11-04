---
'@jannik-stacks/agi': patch
---

The studio run list no longer carries check results or full run records: a check's verdicts are fetched when its panel opens, and each listed run keeps only the fields the list and the Graph read, with an issue's body sent once. On a 130-run data dir `/api/runs` drops from 788 KB to 191 KB.
