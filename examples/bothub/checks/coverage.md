---
type: script
description: The tests related to the change pass, and every line the change adds to src/ runs in one of them.
run: node "$BOTHUB_HUB/scripts/coverage.mjs" src/
paths: [src/**]
mode: block
human: six-angle dogfood review, safety-checks item 4, tuned by dogfood round 2 kinks K13 and K16
---
