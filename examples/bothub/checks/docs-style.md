---
type: script
description: Added docs lines use words instead of symbols, headings are names, and the vocabulary holds.
run: node "$BOTHUB_HUB/scripts/docs-style.mjs"
paths: [studio/content/docs/**]
mode: block
human: user docs style rules in CLAUDE.md, feedback rule 4
---
No middle dots or math symbols, no em-dash or colon suffixes on headings, never "inert" or
"executor", no marketing words. Only lines the change adds count; fenced code is skipped.
