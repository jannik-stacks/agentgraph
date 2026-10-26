---
mode: block
each: node "$AGENTGRAPH_DIR/scripts/criteria.mjs"
agent: reviewer
max: 5
---
The change to src/, studio/src/ and the graph scripts meets each acceptance criterion, one criterion per run.

The item is the task, one acceptance criterion, the test that proves it, the change to the files under
`src/`, `studio/src/` and `examples/agentgraph/scripts/` that its test file names, and what the brief leaves
out of scope. Judge from the item; read other code only for a path the change calls into and the item
does not show. Judge only the behaviour the criterion states.
Look for one concrete sequence of events within what the criterion and the task describe under which
the changed code does not do what the criterion says: an add, a remove, a re-add by a human through
the forge, a restart, an empty or repeated input. Follow every code path that changes the state
the criterion is about, each changed function in full, and check each one keeps the invariant the
criterion needs. Read the test code too: an assertion that expects what this criterion or one of the
other criteria rules out, such as a wording a row says must never appear, is a fail on its own;
quote the assertion and the row.

Fail only when the stated behaviour is missing or wrong: quote the words of the criterion the
sequence breaks, give a concrete input those words cover, and the line it goes wrong on. The
sequence must run through agentgraph's own inputs and documented use. A sequence that needs a case
listed under `out of scope`, a human hand-editing text agentgraph wrote (a marker in an issue body, a
stored file), malformed Unicode or other input crafted to break the code does not count; neither
does an input or case the criterion and the task do not mention, such as an unusual number format,
a limit nobody asked about, a deeper syntax form, another scope or an older helper the change only
calls. Those are gaps, not findings: answer pass and write one line `Known gap: <input>, <line>` for
each; they go into the pull request's Known gaps, not back to the agent. Pass when you cannot build a
failing sequence from the code.
