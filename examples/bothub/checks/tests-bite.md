---
type: script
description: Every test the change adds fails on the base code, so it would catch the change being reverted.
run: node "$BOTHUB_HUB/scripts/tests-bite.mjs"
paths: [tests/**]
mode: block
human: six-angle dogfood review, narrow-bots W1 test-bites script
---
The script copies the base commit to a temporary directory, puts the change's `tests/` files on
top and runs only the test files that gain a test. A new test that passes there proves nothing
about the change. A test titled `still …` guards behavior that already worked and may pass.
