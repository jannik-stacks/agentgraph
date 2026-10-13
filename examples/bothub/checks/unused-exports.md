---
type: script
description: Every export the change adds is used by another file.
run: node "$BOTHUB_HUB/scripts/unused-exports.mjs"
paths: [src/**, studio/src/**]
mode: warn
---
An export nothing imports is code nobody needs yet. Drop the export, or the code.
