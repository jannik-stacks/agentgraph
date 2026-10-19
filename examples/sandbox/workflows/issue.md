---
on: { issues: { label: agent:ready } }
branch: bothub/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
    checks: [tests, pr-text]
  review:
    agent: reviewer
    back: implement
    rounds: 2
    until: the change does what the issue asks and the tests cover it
  merge: { wait: human, back: implement }
---
A maintainer adds the `agent:ready` label to a triaged issue. The implementor changes the package
until the tests pass. The reviewer reads the change and sends it back while it falls short. A human merges.
