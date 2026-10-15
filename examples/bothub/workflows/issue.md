---
on:
  issue_comment:
    types: [created]
    command: /bothub
    guard: { associations: [OWNER, MEMBER, COLLABORATOR] }
steps:
  triage:
    bot: triager
    checks: [triage-brief, triage-width]
    tries: 2
    minutes: 10
  implement:
    bot: implementor
    branch: bothub/{issue}
    checks:
      - safety
      - size
      - rules
      - lint
      - types
      - studio-build
      - tests
      - old-tests
      - test-guards
      - coverage
      - code-shape
      - unused-exports
      - shape
      - propagation
      - enum-copy
      - docs-sync
      - criterion-met
      - removed
      - state-transitions
      - reduce
      - review-src
      - near-duplicate
      - review-docs
      - docs-stale
      - docs-tone-provenance
      - docs-tone-repeats
      - risky
      - scope
      - review-tests
      - docs-tone-tagline
      - docs-tone-marketing
      - tooltip-text
      - notes-followed
      - principle-named
    tries: 4
    minutes: 60
  review:
    wait: human
human: seed hub, checks lists extended by each wave, untraced; the studio twin folded in once safety and code-shape covered studio/src
---
A maintainer comments `/bothub` on an issue about the engine, the studio or the dashboard. The
triager replies with a brief in a fixed template: the task, at most five criteria that each name the
test proving them, the files and what is out of scope. The implementor works on `bothub/<issue>`
until every check passes, at most four attempts.

The scripts run first and decide everything a rule can: the change stays small and in bounds,
follows the written rules, keeps the suite intact, adds the criteria's tests, those tests fail on
the base code, every added line runs in a test, and studio code keeps the studio's UI rules. Then
narrow judges each answer one question: each criterion against the code, each removed behavior, the whole change followed
through the state it touches, each code hunk, each new export, each docs hunk and its tone. Checks
in log mode record their answer on the attempt that goes through and never gate: each risky call,
each run status or closure the change touches, each file outside the brief, each test hunk, two tone questions and each tooltip. A failing `block`
check goes back to the implementor with its findings and those of failing `warn` checks; `warn`
findings alone go through with the change. Review waits on a human, who merges.
