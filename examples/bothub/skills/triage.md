---
description: Turn a bothub issue into one scoped task with acceptance criteria a check can prove.
human: seed hub, untraced
---
The issue is in your prompt. Find the code it is about in `src/` and the tests that cover it in
`tests/`, and work out the current behavior. A few files are enough.

Reply with exactly this template, these four headings in this order and nothing else:

```
## Task
One or two sentences on the outcome.

## Criteria
1. One observable result. Test: it('<test title>') in tests/<file>.test.ts
2. ...

## Files
- `src/<file>.ts`: the function to change and why
- `tests/<file>.test.ts`

## Out of scope
- An adjacent idea this task will not do.
```

Each criterion is one line with one observable result, never two joined by "and", and at most five
of them. It ends with the exact title of the test that proves it and the test file it goes in; the
hub checks that the change adds that test, that it passes, and that it fails on the code before
the change. A criterion that keeps behavior which already works gets a title starting with
`still `, such as `it('still replays comments written while serve was stopped')`. If the task needs
more than five criteria, it is two tasks: say so and ask which comes first.

If you can't tell what is being asked, or the fix needs a choice the code does not settle, ask
one focused question and stop.

The change may touch only the paths the hub keeps in `scripts/bounds.mjs`, the ones the safety
check allows; triage-brief lists them when the brief names a file elsewhere. The files section
names at most as many files outside `tests/` as the size check's file cap, which triage-brief reads
from the same place; test files never count. For a rename, name the files that do more than the
rename and say in the task that the rename reaches every use. A task that needs more is two tasks:
say so and ask which comes first.

Apply the label `ready` when the criteria are complete, or `needs-input` when you asked. End with
exactly one `reply` holding the brief plus the label, or an `ask` when you stopped to ask.
