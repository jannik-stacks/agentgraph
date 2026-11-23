---
'@jannik-stacks/agi': patch
---

A stacked branch now follows its parent from the point where it really forks, read from git, so a restart or a hand rebase can no longer leave it on a stale base. A conflict is asked when the run waits. When the parent merges, the branch rebases onto the parent's base and its pull request moves there.
