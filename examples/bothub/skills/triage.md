---
description: Turn a bothub issue into one scoped task with acceptance criteria a check can prove.
human: seed hub, untraced; one ask for every open choice (X4), follow-ups for a split issue (X5), a first task that delivers a Done-when row (X9) and interacting criteria (X12) from dogfood x; paths pointed at, not copied, from dogfood round 9 (K3); ask fields matched to the ask schema, fewer asks and a files budget per Done when row from dogfood round 11 (K1, K2, K5)
---
The issue is in your prompt. Find the code it is about in `src/` and the tests that cover it in
`tests/`, and work out the current behavior. A few files are enough. Every tool result stays in the
conversation, so `grep -n` first and `read` with `offset` and `limit`, not whole files.

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
`still `, such as `it('still replays comments written while serve was stopped')`. When two criteria
touch the same input or function, add a criterion for how they interact.

Brief the cause where it lives. When the issue names one harness, check or caller, grep for the
others on the same path and fix the shared layer. When the issue offers alternatives, pick the one
that catches the bug it cites, and make criterion 1 replay that bug. Anything the change removes or
bypasses, such as a fallback, a config option or a carried summary, gets a `still` criterion or an
`## Out of scope` line saying it is dropped on purpose.

Match the criteria to what the issue asks: one per item of its `Done when` list, and add one only
when the issue clearly needs it. A one-line fix gets one criterion and one small test.

Name under `## Files` only what the `Done when` rows need, about two files outside `tests/` per
row; the triage-width check flags more.

When the issue is several tasks, because it needs more than five criteria or more files than the
cap below, brief the first one. It delivers at least one row of the issue's "Done when" end to end
through the code path that exists today, so its criteria test that path; a new module only later
tasks would call is not a first task. Say in the task that it is the first of several, and list each
remaining task under `## Out of scope` as a line starting with `Follow-up:`.

A task that adds a member to a union or kind reaches every exhaustive `Record`, `switch`, test and
docs page over it: grep for them and name each under `## Files`.

Ask only when two readings of the issue lead to different code and neither the issue nor the code
picks one. Do not ask what the `Done when` already says, how to build it, or a number the issue
leaves open: pick the reading closest to `Done when`, choose a small number, and say so in the task.
When you must ask, ask once and stop: one `ask` that lists every open choice, numbered, each with
the options you see, so a single answer settles all of them. Write it for a maintainer who has not
read the code: one plain sentence on what needs deciding, then each option in plain words. An
`ask` has only a `question`; its first line becomes the issue title, so make that line a short
question under 80 characters.

The change may touch only the paths the safety check allows. The hub keeps them in its own
`scripts/bounds.mjs`, which is not in this repository; triage-brief lists them when the brief names
a file elsewhere or the issue's `Done when` names a path elsewhere, and says when the safety check
would fail a file the brief names. The files section names at most 8 files outside `tests/`, the
size check's file cap; test files never count. For a rename, name the files that do more than the
rename and say in the task that the rename reaches every use.

Apply the label `ready` when the criteria are complete, or `needs-input` when you asked. End with
exactly one `reply` holding the brief plus the label, or an `ask` when you stopped to ask.
