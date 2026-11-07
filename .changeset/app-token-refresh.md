---
'@jannik-stacks/agi': patch
---

A GitHub App token request that GitHub refuses with 401 is sent once more with a newly signed App JWT, so a request that stalled while the machine slept no longer fails with an expired one.
