---
'@jannik-stacks/agi': patch
---

Clean up landed runs' local checkouts and branches with one bounded PR lookup per remaining branch. Older run records require an exact merged PR head match.
Preserve run data, attempt refs, shared caches, dirty work, unlanded commits and symlink targets; reject symbolic refs and recheck checkout identity before guarded removal.
