---
'@jannik-stacks/agi': patch
---

No more sticky "Agentgraph status" comment. The issue's status label (or tracker folder) now follows the run records, and the engine posts new comments only: `Opened a pull request.`, `Done.` and `Stopped.` for workflows with a branch, and one question that mentions who spoke last when a run needs someone. They go on the issue until a pull request exists, then on the pull request. Retros and conflict runs post nothing. Old status comments are left as they are, `Run.comment` is gone, and comment proposals can no longer edit an earlier comment.
