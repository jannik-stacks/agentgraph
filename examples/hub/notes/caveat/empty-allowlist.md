---
title: An empty tool allowlist denies reads too
status: accepted
evidence: [examples/hub/bots/reviewer.md]
---

A bot with `tools: []` cannot even read files. Give review bots `Read`, `Grep` and `Glob`. This one
comes from Claude Code's `dontAsk` permission mode, not from bothub itself.
