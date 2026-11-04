---
'@jannik-stacks/agi': patch
---

Toolchain and package caches are kept per repo: each repo gets its own `agentgraph-cache-<repo>-<hash>` volume, hashed from the repo name (or its origin when it has none), the image ID and the toolchain, and `AGENTGRAPH_CACHE_VOLUME` is now the name prefix. Environment builds of one cache volume run one at a time. Environments are rebuilt once (format 7), and commands outside a checkout no longer mount a cache. `bin/env.ts` and low-disk collection count and remove cache volumes like environments, and free docker disk is measured without a volume. The old shared volume is no longer used; `docker volume rm agentgraph-cache` frees it.
