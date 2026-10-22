---
title: Each test case is a row, not a loop
status: accepted
check: test-guards
human: user feedback across sessions
---
A test reads top to bottom and asserts unconditionally. When several inputs share one test, they
become rows of an upcased const array just above an `it.each`, not a `for` loop with `expect(`
inside, and never a loop inside a loop. An `expect(` never sits under an `if` or `else`: a case that
expects something else is its own test. A loop that only sets things up, or collects results that
one `expect(` checks after it, is fine.

A test checks what the code does with data, not the data. When a change edits example or fixture
files, the test that loads them, such as compiling the example hub, covers them; a new test that
re-reads the files and lists their keys only restates the edit. Leave out casts the types do not
need, such as `as { … }` on parsed data or `as const` on a table; `!` on a lookup the test controls
is fine, since a missing value throws there anyway.

Bad:

```ts
it('accepts every association list', () => {
  for (const list of [['OWNER'], [], ['NONE']]) {
    const result = compile([workflow(list)]);
    if (list.length) expect(result.ok).toBe(true);
    else expect(result.ok).toBe(false);
  }
});
```

Good:

```ts
const ASSOCIATION_LISTS = [
  { list: ['OWNER'], ok: true },
  { list: ['NONE'], ok: true },
  { list: [], ok: false },
];

it.each(ASSOCIATION_LISTS)('compiles associations $list', ({ list, ok }) => {
  expect(compile([workflow(list)]).ok).toBe(ok);
});
```
