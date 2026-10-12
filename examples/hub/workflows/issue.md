---
on:
  issue_comment:
    types: [created]
    command: /bothub
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
  pull_request:
    types: [opened, synchronize]
jobs:
  implement:
    on: { issue_comment: {} }
    bot: implementor
    skill: implement
    branch: bothub/{issue}-{slug}
    until: { checks: [types, review], max: 2 }
    can: [reply, push, open-pr, ask]
    mode: warn
  review:
    on: { pull_request: {} }
    bot: reviewer
    skill: review
    can: [reply]
---

A `/bothub` comment on an issue starts the implementor on its own branch. Its work reaches a pull
request only once the typecheck and the per-file review pass. Pull requests get a second review.
