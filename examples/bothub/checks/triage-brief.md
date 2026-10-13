---
type: script
description: The triage reply follows the brief template, with at most five criteria that each name a test title and file.
run: node "$BOTHUB_HUB/scripts/triage-brief.mjs"
mode: warn
---
The sections are `## Task`, `## Criteria`, `## Files` and `## Out of scope`, in that order. Each
criterion is one numbered line that ends in `Test: it('<title>') in tests/<file>.test.ts`. The
script reads the reply from `BOTHUB_REPLY` and passes with a note when it is not set, so it gates
only once the hub hands the reply to checks.
