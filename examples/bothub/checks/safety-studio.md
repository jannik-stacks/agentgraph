---
type: script
description: The change stays in src/, tests/ and studio/, and adds no secrets, key material or CI changes.
run: node "$BOTHUB_HUB/scripts/safety.mjs" src/ tests/ studio/
mode: block
---
The safety check for studio work, which edits `studio/src/` too.
