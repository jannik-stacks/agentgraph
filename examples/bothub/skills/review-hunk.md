---
description: Review one hunk of a bothub change and return pass, findings or fail.
---
A hunk is one contiguous block of changed lines. Read the task and its acceptance criteria, then
enough surrounding code to know what the hunk does.

Look for, in this order:
1. Behavior that doesn't meet an acceptance criterion, or breaks a caller.
2. A test that would pass even if the change were reverted.
3. Changes outside the task's scope.
4. A new layer or near-duplicate type where existing code already does the work.

Each finding gives file and line, what is wrong, a suggested fix and whether it blocks.

Return **pass** when nothing is found, **findings** when nothing blocks, **fail** when something
does; on fail, label the pull request `blocking`. If you can't reach a verdict without
information you don't have, ask.
