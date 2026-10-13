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
        - safety
        - harness-memory
        - size
        - test-integrity
        - docs-style
        - comments
        - lint
        - format
        - types
        - studio-build
        - live-stream
        - tests
        - tests-bite
        - coverage
        - criteria-tests
        - escape-hatches
        - unfinished
        - retired-names
        - docs-prose
        - docs-sync
        - code-shape
        - studio-ui
        - react-hints
        - unused-exports
        - risky
        - scope
        - near-duplicate
        - criterion-met
        - design
        - review-src
        - review-tests
        - review-docs
        - docs-tone-tagline
        - docs-tone-marketing
        - docs-tone-repeats
        - docs-tone-provenance
      max: 3
    returns: [reply, push, merge-request, note, ask]
    tools: [issues_get, notes_search]
    mode: warn
    timeout-minutes: 60
---
A maintainer comments `/bothub` on an issue. The triager replies with a brief in a fixed template:
the task, at most five criteria that each name the test proving them, the files and what is out of
scope. The implementor works on `bothub/<issue>` until every check passes, at most three rounds.

The scripts run first and decide everything a rule can: the change stays small and in bounds,
keeps the suite intact, adds the criteria's tests, those tests fail on the base code, and every
added line runs in a test. Then narrow judges each answer one question: each criterion against
the code, the whole change followed through the state it touches, each code hunk, each test and
docs hunk, each risky call and each new export. A failing gating check goes back to the
implementor with its findings. A human merges.
