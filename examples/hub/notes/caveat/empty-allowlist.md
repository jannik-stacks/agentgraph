---
title: An empty tool allowlist denies reads too
status: accepted
evidence: [examples/hub/bots/reviewer.md]
---

A bot with `tools: []` cannot even read files. Give review bots `Read`, `Grep` and `Glob`. Both
harnesses deny every tool outside the allowlist.
