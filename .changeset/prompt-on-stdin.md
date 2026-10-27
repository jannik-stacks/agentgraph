---
'@jannik-stacks/agi': patch
---

Harnesses read the prompt on stdin from a file in the session home, so a long prompt no longer overflows the argument limit with `spawn E2BIG`. A defect while a run works, such as a failed spawn, now parks that run with a runner error instead of stopping the loop.
