---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  implement: { agent: implementor, tries: 1 }
  merge: { wait: human }
---
The bench floor: one plain session on the issue, no checks and no review, in the hub's own sandbox.
