---
type: script
description: The change stays in src/, tests/, the studio source and seed, and the docs pages, and adds no secrets, key material or CI changes.
run: node "$BOTHUB_HUB/scripts/safety.mjs" src/ tests/ studio/src/ studio/seed.ts studio/content/docs/
mode: block
human: seed hub, entropy scan added from safety-checks ranked item 6
---
Secrets are found by their known prefixes, bearer tokens, URLs with a password in them, and long
tokens of mixed case and digits as random as a generated key. Recorded ids in `tests/fixtures/`
are left to the prefix rules.
