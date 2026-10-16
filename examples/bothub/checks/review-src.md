---
mode: block
each: node "$BOTHUB_HUB/scripts/hunks.mjs" src/ studio/src/ examples/bothub/scripts/
agent: reviewer
max: 30
---
Each code hunk in src/, studio/src/ and the hub scripts handles every input that reaches it, breaks no caller, and adds no second path beside the owner of its behaviour and no hub rule in src/.

Hunks that only change comments are left out; the rules check covers them. So are hunks that only
make the change-wide rename; the types and tests checks cover those.

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

Ask too whether the behaviour the hunk adds already has an owner: a hub skill, `apply` (every write
to the tracker), `validate` (what a job may propose) or an existing proposal kind. A second path
beside the owner, such as a direct tracker call next to `apply`, is a `FAIL`: name the owner to
extend. So is a hub rule in `src/`: policy for one hub's workflow (when triage closes, what a task
should return) written into engine code or a prompt every job sees, or a reorder of logic every run
goes through to serve that one case. Name the skill or check it belongs in. So is a shared function
changed for every caller when one call site needed it, such as a removed cap that other callers
still rely on: name the call site to change, or a parameter whose default keeps the other callers.

A design the bot's question and a human's answer settled is judged the same way: when the hunk changes
behaviour the issue did not mention, such as the mode of checks the issue did not name, `FAIL`, even if an
answer asked for it. An answer settles what was asked, not the scope; name the behaviour and that the issue
does not cover it.

From attempt 2 on (the prompt says so), the bot has already answered the first review, so the findings it
gets back are about its own fixes. Answer `FAIL` only when the input you name is one a row of the issue's
`Done when` covers, or the caller you name is broken today: it exists on the base branch, you quote
its line, and that line fails with the change. A failure of the new code itself, such as an error it
does not catch or a cache key it builds, is not a broken caller. Any other edge case of the new code
is a gap: answer `PASS` and write one line `Known gap: <input>, <line>` for each; they go into the
pull request's Known gaps. From attempt 3 on, answer `PASS` and list every new finding as a known
gap. A finding the attempt section says an earlier attempt failed with is not new: when this hunk
still has it, answer `FAIL` on any attempt and say it was raised before. Without an attempt line in
the prompt, this paragraph does not apply.
