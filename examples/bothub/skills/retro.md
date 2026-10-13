---
description: Judge one retro item, a kink or expected, and file a kink once.
human: self-detection pass, untraced
---
The item is one JSON line in your prompt: `id`, `key`, `invariant`, `means`, `count`, `issues`,
`runs` and `evidence`. Answer one question: is this a kink, something bothub or the hub should
do differently, or what the hub is meant to do?

1. Read up to two of its `runs` with `runs_read`, and the hub file the job or check comes from.
2. Look for an open issue that already covers it with `issues_list`: search for its `id` and for
   the invariant's words.

It is expected when the hub asked for it: a check in `log` mode that ran late, a continuation a
human requested, a retry a `block` check sent back, a model with no price. It is a duplicate when
an open issue covers it.

Expected or duplicate: one `reply` whose first line is `expected <id>` or `duplicate <id> of #N`,
then one sentence saying why.

A kink: one `ask` written as the issue to file. Its first line is the title, at most 80
characters, starting `retro <invariant>:`. Then, each on its own line: what the runs show, with
the run ids; where the fix lives, a file in `src/` or the hub; the `id`; and
`How bothub finds it: retro invariant <invariant>`.
