---
type: script
description: The change keeps every test the base has, with its assertions, and does not skip, focus or slow them down.
run: node "$BOTHUB_HUB/scripts/test-integrity.mjs"
paths: [tests/**]
mode: block
human: six-angle dogfood review, safety-checks item 3
---
Compared with the base: no deleted test file, no fewer tests or `expect(` calls in a file, no added
`.skip`, `.only` or `.todo`, no test timeout above the 5000 ms default, and no edit under
`tests/setup/`.
