---
mode: block
run: 'npm --prefix studio run build --silent -- --outDir "$TMPDIR/studio-dist" --emptyOutDir > "$TMPDIR/studio-build.log" 2>&1 && echo "studio-build: ok" || { tail -c 7000 "$TMPDIR/studio-build.log"; exit 1; }'
---
The studio type-checks and builds, and no browser code reaches a Node builtin.

The studio imports schemas and helpers straight from `src/`. Its build fails when a module the
browser loads imports `node:crypto`, `node:fs` or any other Node builtin, directly or through
another module. A pass prints one line; the build's chunk-size report stays out of the result.
