---
'@jannik-stacks/agi': patch
---

Toolchain and package caches are kept per repo: each repo gets its own `agentgraph-cache-<repo>-<hash>` volume, keyed by the repo name and its setup hash, and `AGENTGRAPH_CACHE_VOLUME` is now the name prefix. Environments are rebuilt once (format 7), and commands outside a checkout no longer mount a cache.
