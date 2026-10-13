---
type: script
description: Added code defines components at module level, loads routes lazily and tells schema unions apart by type.
run: node "$BOTHUB_HUB/scripts/code-shape.mjs"
paths: [src/**, studio/src/**]
mode: block
---
A component defined inside another function is a new component on every render and loses its
state. `App.tsx` and `main.tsx` import views and the lab with `lazy(() => import(...))`. A zod
`discriminatedUnion` uses `type` as its key, like every hub file kind.
