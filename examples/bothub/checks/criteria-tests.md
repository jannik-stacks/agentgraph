---
type: script
description: The change adds the test each acceptance criterion names, with its exact title, in the file the criterion names.
run: node "$BOTHUB_HUB/scripts/criteria-tests.mjs"
mode: block
---
The criteria come from the triage brief on the issue. Whether the tests pass is the tests check's
job, and whether they would catch a revert is tests-bite's.
