---
on: { issue_comment: {} }
branch: bothub/{issue}
steps:
  triage: { agent: triager, checks: [triage-brief, triage-width], tries: 2 }
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
        risky,
        scope,
        review-tests,
        docs-tone-tagline,
        docs-tone-marketing,
        tooltip-text,
        notes-followed,
        principle-named,
      ]
  compound: { agent: librarian, each: { run: node "$BOTHUB_HUB/scripts/signals.mjs" }, checks: [lesson-size] }
  review: { wait: human, back: implement }
---

A maintainer says `/agent` on an issue about the engine, the studio or the dashboard. The
triager replies with a brief. The implementor works on `bothub/<issue>` until every check passes.
The librarian turns each signal of the run into a lesson in the docs, or drops it. A human reviews
and merges.
