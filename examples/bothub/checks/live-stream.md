---
type: script
description: The dashboard's live stream still resumes without gaps or repeats, and harness usage still carries the fields the cost views read.
run: node_modules/.bin/vitest run --reporter=dot tests/live.test.ts tests/harnesses.test.ts
paths: [src/live.ts, src/api.ts, src/store.ts, src/usage.ts, src/prices.ts, src/types.ts, src/harnesses/**]
mode: block
---
A few seconds. The full suite runs these too; this check names the failure when a change to the
store, the API or a harness breaks what the dashboard streams.
