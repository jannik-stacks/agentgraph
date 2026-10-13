---
type: script
description: The bothub test suite passes, the live stream and harness usage tests among them, and every module it loads loads.
run: node "$BOTHUB_HUB/scripts/tests.mjs"
mode: block
human: seed hub, untraced; live stream must keep resuming without gaps, dashboard work; module load errors fail it, staged run fractional-mtime-cache-bust
---
A pass is one line; a failure lists the failing tests by name first, then the end of vitest's log. A passing
run whose output reports a module that could not load fails with those lines.
