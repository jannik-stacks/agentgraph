---
on: { issue_comment: {} }
branch: bothub/{issue}
steps:
  implement: { agent: implementor, checks: [types, review], tries: 2 }
---

A `/agent` comment on an issue starts the implementor on its own branch. Its work reaches a pull
request only once the typecheck and the per-file review pass.
