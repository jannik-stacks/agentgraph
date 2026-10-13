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
      checks: [safety, harness-memory, docs-style, comments, lint, format, types, studio-build, tests, docs-tone, review]
      max: 3
    returns: [reply, push, merge-request, note, ask]
    tools: [issues_get, notes_search]
    mode: warn
    timeout-minutes: 60
---
A maintainer comments `/bothub` on an issue. The triager replies with a scoped task, and the
implementor works on `bothub/<issue>` until every check passes, at most three rounds: the scripts
first, then the reviewer, who reads the change one hunk at a time for what the scripts cannot
judge. A blocking review finding goes back to the implementor like any other failing check. A
human merges.
