---
title: One task, one small change
status: accepted
check: size
human: safety-checks item 9, size caps, rename rule from dogfood round 2 kinks K7 and K10, one bounds file from dogfood round 5, K20 to K22
---
The hub's `scripts/bounds.mjs` is the one place that says what a change may touch and how big it
may be; the safety, size and triage-brief checks read it, and a test keeps the triage skill's copy
of the paths and file cap equal to it. The hunk reviews leave rename-only hunks out, and their cap
of 30 counts only hunks that change behavior. When a task needs more, triage splits it into tasks
that each fit, and asks which comes first.

The paths include the example hubs under `examples/`, so a schema change migrates them in the same
change, and the studio, which imports from `src/`, so a change to a shared type reaches it too.
