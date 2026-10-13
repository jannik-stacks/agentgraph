---
name: issue
description: From a /bothub comment on a bothub issue to a reviewed pull request.
on:
  issue_comment:
    types: [created]
    command: /bothub
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
jobs:
  triage:
    type: bot
    bot: triager
    skill: triage
    returns: [reply, label, ask]
    tools: [issues_list, issues_get]
    mode: warn
    timeout-minutes: 10
  implement:
    type: bot
    needs: [triage]
    bot: implementor
    skill: implement
    branch: bothub/{issue}
    until:
      checks: [safety, harness-memory, docs-style, comments, lint, format, types, tests, docs-tone]
      max: 3
    returns: [reply, push, merge-request, note, ask]
    tools: [issues_get, notes_search]
    mode: warn
    timeout-minutes: 45
  review:
    type: bot
    needs: [implement]
    bot: reviewer
    skill: review-hunk
    over: each-hunk
    preload: [issue, links, recall]
    returns: [reply, label]
    mode: warn
    timeout-minutes: 20
---
A maintainer comments `/bothub` on an issue. The triager replies with a scoped task, the
implementor works on `bothub/<issue>` until every script check passes (at most three rounds), and
the reviewer reads the change one hunk at a time for what the scripts cannot judge. A human
merges.
