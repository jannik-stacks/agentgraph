---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
    checks: [tests]
  merge: { wait: human, back: implement }
---
The hub for a bench task on a repo with no hub of its own. The implementor changes the repo until its
own test command passes, and a human merges. The bench writes the case's test command into the tests
check of its copy.
