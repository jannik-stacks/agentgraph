---
mode: block
run: cat "$AGENTGRAPH_REPLY"
agent: scout
---
The base of this pull request moved under it. The change itself stayed the same and the tests pass.

Fail only when something new on the base changes what the pull request must do: a function it calls
was renamed or now behaves differently, a file it edits moved, or the base already does what the
pull request adds. Say what needs to change. Otherwise pass.
