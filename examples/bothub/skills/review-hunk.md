---
description: Answer one question about one hunk of a bothub change, PASS or FAIL.
human: seed hub, untraced
---
A hunk is one block of changed lines with the code around it. Other checks judge the criteria,
the tests, the scope and duplicated code, so ask only this: is there an input that reaches this
hunk, or a caller of what it changes, that it now handles wrongly? Read the callers when the hunk
changes a signature or a return value.

Answer `PASS` when you cannot name one. Answer `FAIL` with the input or caller, the line it goes
wrong on and the smallest fix.
