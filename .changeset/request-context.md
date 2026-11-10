---
'@jannik-stacks/agi': patch
---

A run started by `/agent` now gets, in full, every trusted comment since the runs that hear comments on the issue last looked, up to where it first looks, so a request written before a bare `/agent` or just after it is not cut short. The timeline leaves those comments out.
