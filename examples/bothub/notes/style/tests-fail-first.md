---
title: A new test fails on the code before the change
status: accepted
source: bothub sessions
check: test-guards
human: narrow-bots W1 and W2 test first, user feedback no tautological tests, feedback rule 12
---
Write the test a criterion names before the code, and see it fail. A test that passes on the base
code would still pass with the change reverted, so it proves nothing about the change. Assert the
value the change produces, not one that holds either way: `undefined` differs from almost any old
value, so `expect(id).not.toBe(oldId)` passes when the id is missing. A test that restates its own
fixture is rewritten until it fails without the change.

A test that guards behavior which already worked is titled `still …` and may pass on the base.

Bad:

```ts
const id = deliveryId(label);
expect(id).not.toBe(oldId);
```

Good:

```ts
expect(deliveryId(label)).toBe('label:bug:2');
```
