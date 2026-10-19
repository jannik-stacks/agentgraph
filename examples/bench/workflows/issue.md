---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
    checks: [tests]
  review:
    agent: reviewer
    back: implement
    rounds: 2
    until: the change resolves the issue within its scope and the tests cover it
  merge: { wait: human, back: implement }
---
The hub for a bench task on a repo with no hub of its own. The implementor changes the repo until its
own test command passes, the reviewer sends it back while it falls short, and a human merges. The bench
writes the case's test command into the tests check of its copy.
