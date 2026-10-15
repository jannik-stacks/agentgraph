---
on: { issue_comment: { command: /bothub } }
steps:
  plan: { bot: planner }
  write: { bot: implementor, checks: [types, tests] }
  document: { bot: writer, checks: [docs-tone] }
  align:
    bot: reviewer
    back: write
    rounds: 3
    until: the docs describe what the code does, and the code does what the docs promise
---
Plan, write, document, then check that the docs and the code agree; go back to writing until they do.
