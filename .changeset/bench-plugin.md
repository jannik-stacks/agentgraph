---
'@jannik-stacks/agi': patch
---

The studio serves Bench as a built-in page plugin at `/bench`, registered only when it starts with `--bench` dirs, and drops `/api/bench`. The header lists Inbox, Graph, Runs, then every page plugin, then Docs. Results no longer has a Benchmarks source.
