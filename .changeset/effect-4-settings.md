---
'@jannik-stacks/agi': patch
---

An environment variable set to an empty string stays empty again: an empty AGENTGRAPH_TRUST trusts no one and an empty AGENTGRAPH_CACHE_VOLUME turns the cache off. Trusted logins are trimmed, AGENTGRAPH_COMPRESS_DAYS refuses NaN, and plugin tools no longer advertise null for optional fields or NaN and Infinity strings for numbers.
