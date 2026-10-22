---
on: { issue_comment: {} }
steps:
  plan: { agent: planner }
  write: { agent: implementor, checks: [types, tests] }
  document: { agent: writer, checks: [docs-tone] }
  align:
    agent: reviewer
    back: write
    rounds: 3
    until: the docs describe what the code does, and the code does what the docs promise
---

Plan, write, document, then check that the docs and the code agree; go back to writing until they do.
