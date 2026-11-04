---
'@jannik-stacks/agi': patch
---

Release the loop's data directory lock before exiting on SIGTERM or SIGINT so restarts can acquire it immediately.
