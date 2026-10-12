---
name: issue-command
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
    mode: warn
    persona: implementor
    safe-outputs:
      reply: { max: 2 }
      push-branch: { max: 1 }
      open-pr: { max: 1 }
  review:
    on: { pull_request: {} }
    mode: shadow
    persona: reviewer
    safe-outputs:
      reply: { max: 1 }
---

## implement

Do the task in the command text of the triggering comment. Open a pull request that links the issue.

## review

Review the pull request diff. Reply once with findings, most severe first, or say it looks good.
