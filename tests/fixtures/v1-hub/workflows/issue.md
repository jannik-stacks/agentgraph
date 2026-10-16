---
on:
  issue_comment:
    types: [created]
    command: /bothub
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
steps:
  implement:
    bot: implementor
    branch: bothub/{issue}
    checks: [types, review]
    tries: 3
    minutes: 45
  review:
    wait: human
human: seed example, untraced
---

A `/bothub` comment on an issue starts the implementor on its own branch. Its work reaches a pull
request only once the typecheck and the per-file review pass. A human reviews and merges.
