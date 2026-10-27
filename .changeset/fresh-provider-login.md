---
"@jannik-stacks/agi": patch
---

A long-running `agi loop` renews the provider login before each pass, so a ChatGPT login no longer expires mid-run. A failed renewal is logged and the pass keeps the last login.
