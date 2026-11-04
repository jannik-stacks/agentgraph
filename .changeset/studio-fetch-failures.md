---
'@jannik-stacks/agi': patch
---

The studio shows a broken or empty server answer as a failure with Retry and keeps the data it had. It refetches once its live socket connects, reads the run list only while showing it, sends a single run without the list's trail and checks, and serves the graph modules without inline source maps.
