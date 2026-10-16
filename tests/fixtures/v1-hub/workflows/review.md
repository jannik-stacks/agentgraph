---
on:
  pull_request:
    types: [opened, synchronize]
steps:
  review:
    bot: reviewer
    returns: [reply]
    minutes: 20
human: seed example, untraced
---

Every pull request that opens or moves gets a second review from another model family.
