---
on: { issue_comment: {} }
branch: agentgraph/{issue}
steps:
  triage: { agent: triager }
  implement:
    agent: implementor
    tries: 4
    checks:
      [
        safety,
        rules,
        names,
        lint,
        types,
        tests,
        kit-types,
        early-names,
        api-fresh,
        docs-tone,
        export-names,
        claims,
        dash-taglines,
        callouts,
        comment-weight,
      ]
  review:
    agent: reviewer
    skill: review-hunk
    each: hunks
    back: implement
    rounds: 2
    until: no hunk needs a change before it can merge
  merge: { wait: human, back: implement, follow: rebase }
---

A maintainer says `/agent` on an issue. The triager replies with a scoped task and acceptance
criteria. The implementor works on its own branch until the checks pass. The reviewer reads the
change one hunk at a time and sends it back while a hunk needs a change. A human merges.
