---
name: studio
description: From a /bothub-studio comment on a studio issue to a reviewed pull request.
on:
  issue_comment:
    types: [created]
    command: /bothub-studio
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
jobs:
  triage:
    type: bot
    bot: triager
    skill: triage
    until:
      checks: [triage-brief]
      max: 1
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
      checks:
        - safety-studio
        - harness-memory
        - size
        - test-integrity
        - comments
        - escape-hatches
        - unfinished
        - retired-names
        - studio-ui
        - code-shape
        - react-hints
        - unused-exports
        - lint
        - format
        - types
        - studio-build
        - live-stream
        - tests
        - tests-bite
        - scope
        - criterion-met
        - review-src
        - review-tests
        - tooltip-text
      max: 3
    returns: [reply, push, merge-request, note, ask]
    tools: [issues_get, notes_search]
    mode: warn
    timeout-minutes: 60
---
The studio twin of the issue workflow. A maintainer comments `/bothub-studio` on an issue about
the studio or the dashboard. The safety check lets the change reach `studio/src/`, and the UI
scripts gate it on the studio's own rules: shared primitives, tooltips, numbers first, one
spinner per running thing, motion only for new rows and no loading flash. What a script cannot
see, how the page looks and moves, waits for the rendered checks.
