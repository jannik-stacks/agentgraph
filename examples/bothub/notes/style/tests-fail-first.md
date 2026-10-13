---
title: A new test fails on the code before the change
status: accepted
source: bothub sessions
check: test-guards
human: narrow-bots W1 and W2 test first, user feedback no tautological tests, feedback rule 12
---
The implement skill says to write each criterion's test first and see it fail. The usual way such a
test still passes on the base: it asserts a value that holds either way. `undefined` differs from
almost any old value, so `expect(id).not.toBe(oldId)` passes when the id is missing. A test that
restates its own fixture is rewritten until it fails without the change.

Bad:

```ts
const id = deliveryId(label);
expect(id).not.toBe(oldId);
```

Good:

```ts
expect(deliveryId(label)).toBe('label:bug:2');
```
