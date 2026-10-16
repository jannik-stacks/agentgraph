---
title: Logic lives in small pure functions
status: accepted
human: seed example, untraced
---

Keep decisions in small functions that take values and return values, and keep I/O at the edges.
They test without mocks and compose without surprises.
Applies to code under `src/`.
