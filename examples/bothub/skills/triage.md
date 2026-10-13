---
description: Turn a bothub issue into one scoped task with acceptance criteria a check can prove.
human: seed hub, untraced; one ask for every open choice (X4) and follow-ups for a split issue (X5) from dogfood x
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
`still `, such as `it('still replays comments written while serve was stopped')`.

When the issue is several tasks, because it needs more than five criteria or more files than the
cap below, brief the one the others build on. Say in the task that it is the first of several, and
list each remaining task under `## Out of scope` as a line starting with `Follow-up:`.

A task that adds a member to a union or kind reaches every exhaustive `Record`, `switch`, test and
docs page over it: grep for them and name each under `## Files`.

If you can't tell what is being asked, or the work needs choices the code does not settle, ask
once and stop: one `ask` that lists every open choice, numbered, each with the options you see, so
a single answer settles all of them.

The change may touch only `src/`, `tests/`, `studio/src/`, `studio/seed.ts`,
`studio/content/docs/` and `examples/`, the paths the safety check allows (the hub keeps them in its
own `scripts/bounds.mjs`, which is not in this repository); triage-brief lists them when the brief
names a file elsewhere. The files section names at most 8 files outside `tests/`, the size check's
file cap; test files never count. For a rename, name the files that do more than the
rename and say in the task that the rename reaches every use.

Apply the label `ready` when the criteria are complete, or `needs-input` when you asked. End with
exactly one `reply` holding the brief plus the label, or an `ask` when you stopped to ask.
