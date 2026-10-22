---
on: { issue_comment: {} }
branch: agentgraph/{issue}
steps:
  triage: { agent: triager, checks: [triage-brief] }
  implement:
    agent: implementor
    checks:
      [
        limits,
        conventions,
        wiring,
        reach,
        fmt,
        clippy,
        wasm,
        tests,
        review-src,
        criterion-met,
        entry-points,
        simpler,
        limits-warn,
        conventions-warn,
        sdk,
      ]
  review: { wait: human, back: implement }
# optional: implement gains back: triage, until: "the brief names every entry point the change needs"
---

A maintainer says `/agent` on an issue. The triager replies with a brief that names every
entry point the change reaches. The implementor works on `agentgraph/<issue>` until the gating checks
pass. A human reviews and merges.
