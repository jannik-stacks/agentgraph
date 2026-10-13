---
title: Every added line runs in a test
status: accepted
check: coverage
---
Each line a change adds to `src/` runs in at least one test, and the changed files keep the
thresholds in `vitest.config.ts`. An error path counts too: a guard that returns early gets a test
that takes it. Code that only runs in a child process, where coverage cannot follow, belongs in the
coverage `exclude` list, which a human changes.

A line that only makes the change's rename was there before, so coverage, lint and unused-exports
leave it alone; the change is not asked to test or tidy code it only renamed.
