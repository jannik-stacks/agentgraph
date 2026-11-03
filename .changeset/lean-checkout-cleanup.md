---
'@jannik-stacks/agi': patch
---

Removing a checkout no longer blocks the runner while its files are deleted, and command output is scanned for the resource-usage line only where it can be.
