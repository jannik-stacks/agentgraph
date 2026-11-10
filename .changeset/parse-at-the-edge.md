---
'@jannik-stacks/agi': patch
---

Trackers read "Stacks on" and "Depends on" (and GitHub issue dependencies) into issue fields once. A run stacks only with `stacks: true`, and a parent closed without a merged pull request holds it with a reason instead of falling back to the base branch.
