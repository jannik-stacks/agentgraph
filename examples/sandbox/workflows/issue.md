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
    rounds: 1
    until: the change does everything the issue asks and nothing it does not need
  merge: { wait: human, back: implement }
---
A maintainer adds the `agent:ready` label to a triaged issue. The implementor changes the package
until the tests pass. The reviewer reads the change and can send it back once. A human merges.
