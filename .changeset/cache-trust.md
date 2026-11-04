---
'@jannik-stacks/agi': patch
---

A base that neither the default branch nor a workflow `base` branch reaches builds its own environment and never writes the repo's cache volume; its cache writes stay in that environment's own volume. A build while a checkout overlays the cache does the same, and checkouts no longer start while a build writes the cache. Every environment build starts from a fresh lower volume, and build containers are removed before their volumes.
