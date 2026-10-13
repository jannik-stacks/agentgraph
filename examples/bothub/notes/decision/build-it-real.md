---
title: Build it real, never fake it
status: accepted
source: bothub sessions
check: unfinished
---
Shipped code calls the real harness, the real model and the real store. When something is missing,
it gets built, or the run stops with a clear error; it is never replaced by a canned answer. Fakes
belong in `src/sim.ts` and the tests.
