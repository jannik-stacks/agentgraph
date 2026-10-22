---
mode: block
run: node "$AGENTGRAPH_HUB/scripts/tests.mjs"
---
The agentgraph test suite passes, the live stream and harness usage tests among them, and every module it loads loads.

A pass is one line; a failure lists the failing tests by name first, then the end of vitest's log. A passing
run whose output reports a module that could not load fails with those lines. A pass names each criterion test
of the brief that was skipped.
