---
type: script
description: Every line the change adds to src/ runs in a test, and the changed files meet the repository's coverage thresholds.
run: node "$BOTHUB_HUB/scripts/coverage.mjs" src/
paths: [src/**]
mode: block
---
Runs the tests related to the changed files with coverage limited to them, so the thresholds in
`vitest.config.ts` apply to the changed area, then names each added range no test runs.
