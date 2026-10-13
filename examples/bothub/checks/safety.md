---
type: script
description: The change stays in src/, tests/, the studio source and seed, and the docs pages, writes no harness memory files (AGENTS.md, CLAUDE.md, .opencode/), and adds no secrets, key material or CI changes.
run: node "$BOTHUB_HUB/scripts/safety.mjs" src/ tests/ studio/src/ studio/seed.ts studio/content/docs/
mode: block
human: seed hub, entropy scan added from safety-checks ranked item 6; safety for studio work, checks added table; harness memory kept out of the change, dogfood logs, feedback rule 23
---
