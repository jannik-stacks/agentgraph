---
title: A new test fails on the code before the change
status: accepted
check: tests-bite
human: narrow-bots W1 and W2 test first
---
Write the test a criterion names before the code, and see it fail. A test that passes on the base
code would still pass with the change reverted, so it proves nothing about the change. Assert the
value the change produces, not one that holds either way: `undefined` differs from almost any old
value, so `expect(id).not.toBe(oldId)` passes when the id is missing.

A test that guards behavior which already worked is titled `still …` and may pass on the base.
