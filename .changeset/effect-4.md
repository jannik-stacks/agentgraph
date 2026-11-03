---
'@jannik-stacks/agi': patch
---

Runs on Effect 4. An environment variable set to an empty string stays empty: `AGENTGRAPH_TRUST=''` trusts no login instead of the graph's list, and an empty `AGENTGRAPH_CACHE_VOLUME` turns the cache off. An empty `AGENTGRAPH_TRACKER` counts as unset, so the tracker comes from `--tracker` or the App env; with neither, a runner refuses to start and asks for a tracker. Trusted logins are trimmed, `AGENTGRAPH_COMPRESS_DAYS` refuses NaN, and a bad `AGENTGRAPH_EVERY` or `AGENTGRAPH_SESSION_ENV` reads in Effect 4's error wording. Plugin tools advertise null only where the input schema accepts it, and no NaN or Infinity strings for numbers.
