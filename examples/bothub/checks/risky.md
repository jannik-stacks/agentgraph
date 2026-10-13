---
type: decide
description: Each added line in src/ that spawns, evaluates, fetches, reads the environment or removes and writes files gets only input it can trust.
over:
  each: node "$BOTHUB_HUB/scripts/risky.mjs"
  max: 40
paths: [src/**]
threshold: 0.7
mode: log
human: six-angle dogfood review, safety-checks item 6 risky api slicer; no model separates the calibration calls (tev1 scores 0.23 on safe and 0.24 on unsafe, qwen3.5 and smart fail most safe ones), so it logs until the question or the slice gets sharper
---
Is every value that reaches this call either fixed in the code or checked before it gets there, so
that nothing an attacker or a bot controls reaches it unchecked?
