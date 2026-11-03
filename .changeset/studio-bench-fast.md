---
'@jannik-stacks/agi': patch
---

The studio bench page loads fast and stays up: the studio no longer watches bench checkouts, reads finished arm usage from `usage.json`, rescans bench rows only when a log changes, answers a failing request with its error instead of hanging, and refetches at most once per change burst.
