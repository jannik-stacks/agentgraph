---
type: script
description: The studio type-checks and builds, and no browser code reaches a Node builtin.
run: npm --prefix studio run build --silent -- --outDir "$TMPDIR/studio-dist" --emptyOutDir
paths: [src/**, studio/**]
mode: block
---
The studio imports schemas and helpers straight from `src/`. Its build fails when a module the
browser loads imports `node:crypto`, `node:fs` or any other Node builtin, directly or through
another module.
