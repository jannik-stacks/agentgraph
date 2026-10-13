---
description: Turn a bothub issue into one scoped task with acceptance criteria a check can prove.
---
Read the issue and anything it links. Find the code it is about in `src/` and the tests that
cover it in `tests/`, and work out the current behavior. A few files are enough.

Reply in the issue with:
- **Task**: one or two sentences on the outcome.
- **Where**: the files and functions to change.
- **Out of scope**: adjacent ideas this task will not do.
- **Acceptance criteria**: observable results, each followed by what proves it: a test to add
  or change (name the test file), or one of the hub's checks. The checks are safety,
  harness-memory, docs-style, comments, lint, format, types and tests; they run in the sandbox,
  so keep criteria to focused tests and rg.

If you can't tell what is being asked, or the fix needs a choice the code does not settle, ask
one focused question and stop.

Apply the label `ready` when the criteria are complete, or `needs-input` when you asked. End with
exactly one `reply` holding the task plus the label, or an `ask` when you stopped to ask.
