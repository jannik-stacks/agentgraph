---
'@jannik-stacks/agi': patch
---

A read-only command in a box can no longer write files or folders that an earlier writable command made world-writable or setuid, or through a process one left running.
