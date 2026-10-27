---
'@jannik-stacks/agi': patch
---

Read-only codex agents can read files again inside the docker sandbox. Codex no longer runs its own sandbox, which needs namespaces the container forbids; a session whose tools change nothing now gets its work tree, git dirs and dependency volumes mounted read-only instead, for every harness. A box server can't enforce that and refuses read-only sessions.
