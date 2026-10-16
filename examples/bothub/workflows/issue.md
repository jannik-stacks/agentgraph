---
on: { issue_comment: { command: /bothub } }
branch: bothub/{issue}
steps:
  triage: { agent: triager, tries: 2 }
  implement:
    agent: implementor
    tries: 4
    checks:
      [
        safety,
        size,
        rules,
        lint,
        types,
        studio-build,
        tests,
        old-tests,
        test-guards,
        coverage,
        code-shape,
        unused-exports,
        propagation,
        enum-copy,
        docs-sync,
        criterion-met,
        removed,
        state-transitions,
        reduce,
        review-src,
        near-duplicate,
        review-docs,
        docs-stale,
        docs-tone-provenance,
        docs-tone-repeats,
        scope,
        review-tests,
        docs-tone-tagline,
        docs-tone-marketing,
        tooltip-text,
      ]
  review: { wait: human, back: implement }
---

A maintainer comments `/bothub` on an issue about the engine, the studio or the dashboard. The
triager replies with a brief. The implementor works on `bothub/<issue>` until every check passes. A
human reviews and merges.
