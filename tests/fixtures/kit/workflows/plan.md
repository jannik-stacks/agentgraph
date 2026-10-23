---
on: { issue_comment: {} }
branch: agentgraph/{parent}-{issue}
base: agentgraph/{parent}
steps:
  implement: { agent: implementor, checks: [safety, rules, names, lint, types, tests, kit-types, early-names] }
---

Each step of a plan is a sub-issue. A maintainer says `/agent plan` on one, and the implementor works
on `agentgraph/<plan>-<step>` until the checks pass, then asks to merge it into the plan's branch.
