---
"@jannik-stacks/agi": patch
---

An interrupted host git, such as a box sync cut off by a command timeout, now removes its index lock, so the next sync does not fail on a stale lock.
