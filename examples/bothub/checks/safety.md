---
type: script
description: The change stays in src/, tests/ and the docs pages, and adds no secrets, key material or CI changes.
run: node "$BOTHUB_HUB/scripts/safety.mjs" src/ tests/ studio/content/docs/
mode: block
---
