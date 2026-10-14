---
description: Answer one question about one hunk of a bothub change, PASS or FAIL.
human: seed hub, untraced; call the deciding module and out of scope from dogfood round 6 (T2); reachable inputs only from dogfood x (X2)
---
A hunk is one block of changed lines with the code around it. Other checks judge the criteria, the
tests, the scope and duplicated code, so ask only this: is there an input that reaches this hunk, or
a caller of what it changes, that it now handles wrongly? Read the callers when the hunk changes a
signature or a return value.

An input counts when it reaches the hunk through bothub's own inputs and documented use: a hub file,
an event, a model reply, a stored run, a config value, at any size the API returns (more than one
page of results is ordinary). A human acting through the tracker (labels, comments, closing) is
documented use; a human hand-editing text bothub wrote (a marker in an issue body, a stored file),
malformed Unicode and other input crafted to break the code are notes, not findings. So is an input
that only a case under the item's `out of scope` reaches: the brief left it out on purpose. Judge
the lines the hunk changes; the code around them is context.

Answer `PASS` when you cannot name one, with any notes after the verdict. Answer `FAIL` with the
input or caller, the line it goes wrong on and the smallest fix. When it goes wrong because the hunk
restates a rule another module already decides (dispatch, config, the pipeline), the smallest fix is
to call that module's function, not to copy one more of its conditions: name the function. Also
answer `FAIL` when the hunk handles an input shape that no producer in the repository emits, or
builds a parser or analysis where changing an input of existing code (an env var, a header, a flag)
would fix the cause: name the smaller change. The same goes for a hunk that scans the filesystem
(a recursive directory walk, or one scan per input token) where an existing file list or index
already answers it, such as `git ls-files`.

From attempt 2 on (the prompt says so), the bot has already answered the first review, so the findings it
gets back are about its own fixes. Answer `FAIL` only when the input you name is one a row of the issue's
`Done when` covers, or the caller you name is broken today: it exists on the base branch, you quote
its line, and that line fails with the change. A failure of the new code itself, such as an error it
does not catch or a cache key it builds, is not a broken caller. Any other edge case of the new code
is a gap: answer `PASS` and write one line `Known gap: <input>, <line>` for each; they go into the
merge request's Known gaps. From attempt 3 on, answer `PASS` and list every finding as a known gap.
Without an attempt line in the prompt, this paragraph does not apply.
