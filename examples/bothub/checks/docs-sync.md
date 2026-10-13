---
type: script
description: Every schema the change adds to src/schema.ts appears on a docs page.
run: node "$BOTHUB_HUB/scripts/docs-sync.mjs"
paths: [src/schema.ts]
mode: warn
human: mined from user feedback, feedback rule 10
---
The reference pages render a schema's fields with `<Fields name="..." />`, so naming it once keeps
the docs in step with the code.
