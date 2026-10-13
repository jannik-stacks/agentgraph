---
type: script
description: The test suite's output reports no module that could not load, even when every test passes.
run: node "$BOTHUB_HUB/scripts/tests.mjs" --load-errors
mode: warn
human: a loader printed could not load and PARSE_ERROR while the suite passed, staged run fractional-mtime-cache-bust; warn until a replay calibrates it
---
Each script check runs in a container of its own, so this one runs the suite again rather than reading the tests
check's output.
