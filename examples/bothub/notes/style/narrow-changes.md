---
title: One task, one small change
status: accepted
check: size
---
A change adds at most 300 lines and touches at most 8 files outside `tests/`. Tests don't count,
so a change never has to test less to fit, and neither do files that only make the change's one
rename, so a rename is done everywhere at once. The hunk reviews leave rename-only hunks out too,
and their cap of 30 counts only hunks that change behavior. When a task needs more, triage splits it into tasks
that each fit, and asks which comes first.

The implement job may touch `src/`, `tests/`, `studio/src/`, `studio/seed.ts` and
`studio/content/docs/`. The studio imports from `src/`, so a change to a shared type reaches the
studio in the same change. A brief that names a file elsewhere fails the triage-brief check.
