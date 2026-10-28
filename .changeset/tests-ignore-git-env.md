---
"@jannik-stacks/agi": patch
---

Tests drop git's repository environment variables, so running them from a git hook or rebase step cannot write into the surrounding repository.
