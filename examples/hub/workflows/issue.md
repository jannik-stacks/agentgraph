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
    type: bot
    on: { issue_comment: {} }
    bot: implementor
    skill: implement
    branch: bothub/{issue}
    until: { checks: [types, review], max: 2 }
    returns: [reply, push, merge-request, ask]
    tools: [issues_get, notes_search]
    mode: warn
  review:
    type: bot
    on: { pull_request: {} }
    bot: reviewer
    skill: review
    preload: [issue, recall]
    returns: [reply]
---

A `/bothub` comment on an issue starts the implementor on its own branch. Its work reaches a pull
request only once the typecheck and the per-file review pass. Pull requests get a second review.
