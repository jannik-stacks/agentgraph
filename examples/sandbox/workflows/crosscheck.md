---
on: { issues: { label: crosscheck } }
branch: agentgraph/{issue}
steps:
  implement:
    agent: implementor
    checks: [tests, pr-text, claude-review, gpt-review]
  merge: { wait: human, back: implement }
---
A maintainer adds the `crosscheck` label. The implementor works until the tests pass. Then two
reviewers on different harnesses read each try side by side: Claude Code judges correctness and
opencode judges the tests. Both checks start in warn mode and record their results. Once a replay
shows they judge well, block mode sends what fails back to the implementor's session.
