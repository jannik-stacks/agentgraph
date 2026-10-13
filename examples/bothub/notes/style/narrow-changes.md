---
title: One task, one small change
status: accepted
check: size
human: safety-checks item 9, size caps, rename rule from dogfood round 2 kinks K7 and K10, one bounds file from dogfood round 5, K20 to K22
---
The hub's `scripts/bounds.mjs` is the one place that says what a change may touch and how big it
may be: the paths, the most added lines and the most files outside `tests/`. The safety, size and
triage-brief checks read it. The triage skill repeats the paths and the file cap, since the
triager cannot read the hub, and a test keeps that copy equal to the file. Tests don't count, so a change never
has to test less to fit. Only files that add or change lines count toward the file cap: a file
that only deletes lines does not, and neither does a file that only makes the change's one rename,
so a rename is done everywhere at once. The hunk reviews leave rename-only hunks out too, and
their cap of 30 counts only hunks that change behavior. When a task needs more, triage splits it
into tasks that each fit, and asks which comes first.

The paths include the example hubs under `examples/`, so a schema change migrates them in the same
change, and the studio, which imports from `src/`, so a change to a shared type reaches it too. A
brief that names a file outside the paths, or more files outside `tests/` than the file cap, fails
the triage-brief check.
