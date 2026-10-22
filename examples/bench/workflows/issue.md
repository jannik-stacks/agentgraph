---
on: { issue_comment: {} }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    tries: 3
    checks: [tests]
  review:
    agent: reviewer
    each: { run: node "$AGENTGRAPH_HUB/scripts/review.mjs" }
    back: implement
    rounds: 1
    until: the change does everything the issue asks and nothing it does not need
  merge: { wait: human, back: implement }
---
One issue becomes one pull request. The implementor changes the repo until the tests check passes. A
reviewer reads any change bigger than one small edit and can send it back once. A human merges.
