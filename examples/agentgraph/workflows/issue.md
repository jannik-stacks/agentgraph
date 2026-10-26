---
on: { issue_comment: {} }
branch: agentgraph/{issue}
steps:
  triage: { agent: triager, tries: 2, checks: [hygiene] }
  implement:
    agent: implementor
    tries: 4
    checks:
      [
        safety,
        hygiene,
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
        doc-pairs,
        docs-tone-provenance,
        docs-tone-repeats,
        scope,
        review-tests,
        docs-tone-tagline,
        docs-tone-marketing,
        tooltip-text,
        pr-text,
      ]
  review: { wait: human, back: implement }
---

A maintainer says `/agent` on an issue about the engine, the studio or the dashboard. The
triager replies with a brief. The implementor works on `agentgraph/<issue>` until every check passes. A
human reviews and merges.
