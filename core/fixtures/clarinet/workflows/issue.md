---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  triage: { bot: triager, checks: [triage-brief] }
  implement:
    bot: implementor
    checks: [limits, conventions, wiring, reach, fmt, clippy, wasm, tests, review-src, criterion-met, entry-points,
             simpler, limits-warn, conventions-warn, sdk]
  review: { wait: human, back: implement }
# optional: implement gains back: triage, until: "the brief names every entry point the change needs"
---
A maintainer comments `/bothub` on an issue. The triager replies with a brief that names every
entry point the change reaches. The implementor works on `bothub/<issue>` until the gating checks
pass. A human reviews and merges.
