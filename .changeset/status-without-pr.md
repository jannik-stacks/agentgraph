---
'@jannik-stacks/agi': patch
---

A run that waits with no pull request now shows `needs-answer` instead of asking for a review of a pull request that does not exist. A refused stacked follow no longer replaces the question the run waits on, so clearing it later leaves that question in place.
