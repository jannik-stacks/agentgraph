---
description: Review one hunk of a bothub change and answer PASS or FAIL with findings.
---
A hunk is one contiguous block of changed lines. Read the task and its acceptance criteria in the
issue, then enough surrounding code to know what the hunk does.

Look for, in this order:
1. Behavior that doesn't meet an acceptance criterion, or breaks a caller.
2. A test that would pass even if the change were reverted.
3. Changes outside the task's scope.
4. A new layer or near-duplicate type where existing code already does the work.

Each finding gives file and line, what is wrong, a suggested fix and whether it blocks.

Answer `PASS` when nothing blocks, with any findings that don't block after it, and `FAIL` when
something does. A failing verdict goes back to the implementor, so name the smallest fix.
