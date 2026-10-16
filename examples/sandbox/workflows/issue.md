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
    until: the change does what the issue asks and the tests cover it
  merge: { wait: human, back: implement }
---
A maintainer comments `/bothub` on an issue. The implementor changes the package until the tests
pass. The reviewer reads the change and sends it back while it falls short. A human merges.
