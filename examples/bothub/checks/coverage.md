---
type: script
description: The tests related to the change pass, and every line the change adds to src/ runs in one of them.
run: node "$BOTHUB_HUB/scripts/coverage.mjs" src/
paths: [src/**]
mode: block
human: six-angle dogfood review, safety-checks item 4, tuned by dogfood round 2 kinks K13 and K16
---
Runs the tests related to the changed files with coverage limited to them, then names each added
range no test runs. The whole-file thresholds in `vitest.config.ts` are left to the full coverage
run: the related tests alone fall short of them on files other tests also cover, and a change is
not asked to cover code it did not write.
