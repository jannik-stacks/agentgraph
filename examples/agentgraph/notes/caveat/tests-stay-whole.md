---
title: A failing test is fixed, never weakened
status: accepted
check: test-guards
human: check test-guards
---
When a test fails, fix the code or the test's expectation of the new behavior. Never add `.skip`,
`.only` or `.todo`, raise a test timeout above the 5000 ms default, edit the global setup in
`tests/setup/`, or make a test pass with an assertion that holds whatever the code does. A slow test
gets faster setup, not a longer timeout. Deleting a test or an `expect(` is cleanup when the code it
covers is gone; while that code is still there, the reply or a commit message names the test file
and says why, such as a case folded into an `it.each` row or one that repeats another.

Bad:

```ts
it.skip('retries after a timeout', async () => {
  await sleep(4000);
  expect(attempts()).toBe(2);
}, 30_000);
```

Good:

```ts
it('retries after a timeout', async () => {
  await vi.waitFor(() => expect(attempts()).toBe(2));
});
```
