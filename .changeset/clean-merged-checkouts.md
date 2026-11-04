---
'@jannik-stacks/agi': patch
---

Clean up landed runs' local checkouts and branches, looking up PR state only for remaining agent branches.
Keep run data, attempt refs, shared caches, dirty work and dependency symlink targets; validate git metadata and let Git refuse unsafe removals.
