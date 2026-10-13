---
type: script
description: The bothub test suite passes.
run: node "$BOTHUB_HUB/scripts/tests.mjs"
mode: block
human: seed hub, untraced
---
The whole suite, about 40 seconds in the sandbox, with the dependencies the hub installs. A pass is
one line; a failure lists the failing tests by name first, then the end of vitest's log.
