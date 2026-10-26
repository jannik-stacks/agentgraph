---
mode: warn
each: node "$AGENTGRAPH_HUB/scripts/hunks.mjs" tests/
agent: reviewer
max: 10
---
Each assertion a test hunk adds checks a value the change produces.

The item is one hunk of a test file. Does every assertion it adds compare against a value that
would be different if the code under test had not changed? Fail naming an assertion that holds
either way, such as one that compares against `undefined` or against the input it was given.
Also fail an assertion that only restates data files the change edits, such as re-reading an
example workflow and checking its keys, instead of checking what the code does with them;
otherwise pass. A test whose title is the named test of one of the brief's criteria is required: never
remove it, even when it starts with `still `.
