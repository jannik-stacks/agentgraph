---
title: A failing test is fixed, never weakened
status: accepted
check: test-guards
human: safety-checks item 3, check test-guards
---
When a test fails, fix the code or the test's expectation of the new behavior. Never delete a test
file or a test, drop an `expect(`, add `.skip`, `.only` or `.todo`, raise a test timeout above the
5000 ms default, or edit the global setup in `tests/setup/`. A slow test gets faster setup, not a
longer timeout.

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
