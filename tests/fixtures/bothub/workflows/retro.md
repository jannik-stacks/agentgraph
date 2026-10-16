---
on: { issue_comment: { command: /retro } }
steps:
  retro: { agent: retro, each: { run: node "$BOTHUB_HUB/scripts/retro-items.mjs" } }
---

The retro agent judges one retro item at a time. An expected item gets a reply saying why; a real
kink becomes one sub-issue naming the invariant that found it.
