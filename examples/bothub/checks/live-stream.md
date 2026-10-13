---
type: script
description: The dashboard's live stream still resumes without gaps or repeats, and harness usage still carries the fields the cost views read.
run: node "$BOTHUB_HUB/scripts/tests.mjs" tests/live.test.ts tests/harnesses.test.ts
paths: [src/live.ts, src/api.ts, src/store.ts, src/usage.ts, src/prices.ts, src/types.ts, src/harnesses/**]
mode: block
human: dashboard work, live stream must keep resuming without gaps
---
A few seconds. The full suite runs these too; this check names the failure when a change to the
store, the API or a harness breaks what the dashboard streams.
