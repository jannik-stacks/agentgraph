---
type: script
description: Added code derives values while rendering instead of copying them into state, and new unions use type.
run: node "$BOTHUB_HUB/scripts/code-shape.mjs" --hints
paths: [src/**, studio/src/**]
mode: warn
---
An effect that only calls a setter renders twice and shows the stale value in between. A plain
TypeScript union told apart by `kind` or `tag` reads differently from the schemas; existing ones
stay until they are next touched.
