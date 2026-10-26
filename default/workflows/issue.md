---
on: { issues: { label: agent:ready }, issue_comment: {} }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
    checks: [tests]
  review:
    agent: reviewer
    back: implement
    rounds: 1
    until: the change does everything the issue asks and nothing it does not need
  merge: { wait: human, back: implement }
---
One issue becomes one pull request. The implementor changes the repo until the tests pass. The
reviewer reads the change and can send it back once. A human merges.
