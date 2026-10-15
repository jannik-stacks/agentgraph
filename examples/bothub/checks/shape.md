---
type: script
description: What the change does to the exported surface of src/ and core/, names, fields, importers, near-duplicate types, import cycles and the longest import chain, base against head.
run: node "$BOTHUB_HUB/scripts/shape.mjs" src core
paths: [src/**, core/**]
mode: log
human: shape measurements as a check, a plan and the replay over 40 bothub-main commits
---
