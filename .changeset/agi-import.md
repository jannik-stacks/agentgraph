---
'@jannik-stacks/agi': patch
---

`agi import <commit>|<patch> [<issue file>]` keeps a change made elsewhere as an ended run with no issue, so `check --runs` can score it beside the agents' runs. Every import is a new run; `--meta` keeps JSON as the origin input to pair runs by.
