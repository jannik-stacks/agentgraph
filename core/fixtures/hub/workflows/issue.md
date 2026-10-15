---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  implement: { bot: implementor, checks: [types, review], tries: 2 }
---
A `/bothub` comment on an issue starts the implementor on its own branch. Its work reaches a pull
request only once the typecheck and the per-file review pass.
