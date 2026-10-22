---
mode: block
each: node "$AGENTGRAPH_HUB/scripts/reduce.mjs"
agent: reviewer
max: 1
---
Nothing the change adds is more than its Done-when rows need.

The item is the task, the Done-when rows and every line the change adds, each with its file and line.
Name added lines that can go without losing a row: a test no row names, a `still` test for code the
change does not touch, a fixture or helper used once, a branch for an input no producer emits, a
rule another module already decides. A test that is the only one running an added src/ line stays:
the coverage check requires it.

Under `helpers`, each new function comes with existing exports whose names share a word with it.
Should the change call one of them instead? When one already does the new function's job, name the
new function and the export to use. A new function not listed there is never a finding for this.

FAIL listing each as `file:line`, with what to delete. PASS when nothing can go.

From attempt 2 on (the prompt says so), FAIL only on a whole test, function or file that can go. From
attempt 3 on, PASS and list the rest as notes. Without an attempt line in the prompt, this paragraph
does not apply.
