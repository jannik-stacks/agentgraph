---
title: Every added line runs in a test
status: accepted
check: coverage
human: dogfood round 2 kinks K13 and K16
---
Each line a change adds to `src/` runs in at least one test. An error path counts too: a guard that returns early gets a test
that takes it. Code that only runs in a child process, where coverage cannot follow, belongs in the
coverage `exclude` list, which a human changes.

A line that only makes the change's rename was there before, so coverage, lint and unused-exports
leave it alone; the change is not asked to test or tidy code it only renamed. For the same reason
the check leaves the whole-file thresholds out: a small fix in a file with old untested code is
not asked to cover that code.
