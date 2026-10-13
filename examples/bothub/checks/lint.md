---
type: script
description: Changed code passes oxlint with the repository config on the lines it adds, and changed files are formatted with oxfmt and the repository config.
run: node "$BOTHUB_HUB/scripts/lint.mjs"
mode: block
human: seed hub, narrowed to added lines by safety-checks item 5; format seed hub, untraced
---
