---
type: decide
description: Each added line in src/ that spawns, evaluates, fetches, reads the environment or removes and writes files gets only input it can trust.
over:
  each: node "$BOTHUB_HUB/scripts/risky.mjs"
  max: 40
paths: [src/**]
threshold: 0.7
mode: shadow
---
Is every value that reaches this call either fixed in the code or checked before it gets there, so
that nothing an attacker or a bot controls reaches it unchecked?
