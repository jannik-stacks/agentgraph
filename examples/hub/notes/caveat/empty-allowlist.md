---
title: An empty tool allowlist denies reads too
status: accepted
evidence: [examples/hub/bots/reviewer.md]
---

A bot with `tools: []` cannot even read files. Give review bots `read`, `grep` and `glob`
(`find` on pi). Both harnesses deny every tool outside the allowlist, and `bothub check` rejects
names the bot's harness does not have.
