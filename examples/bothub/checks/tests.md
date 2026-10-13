---
type: script
description: The bothub test suite passes, the live stream and harness usage tests among them.
run: node "$BOTHUB_HUB/scripts/tests.mjs"
mode: block
human: seed hub, untraced; live stream must keep resuming without gaps, dashboard work
---
A pass is one line; a failure lists the failing tests by name first, then the end of vitest's log.
