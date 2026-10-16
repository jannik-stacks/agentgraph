---
mode: warn
run: node "$BOTHUB_HUB/scripts/docs-sync.mjs"
---
Every schema the change adds to src/hub.ts appears on a docs page.

The reference pages render a schema's fields with `<Fields name="..." />`, so naming it once keeps
the docs in step with the code.
