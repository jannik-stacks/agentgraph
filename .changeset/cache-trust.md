---
'@jannik-stacks/agi': patch
---

A base that is not on the default branch builds its own environment and never writes the repo's cache volume; its cache writes stay in that environment. A build while a checkout overlays the cache does the same, and checkouts no longer start while a build writes the cache.
