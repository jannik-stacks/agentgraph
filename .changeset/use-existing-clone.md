---
'@jannik-stacks/agi': patch
---

A local instance checks out from its forge directly, so the second copy of the repo in `mirror.git` is gone. Branches reach your repo as a pack and one `agentgraph/<n>` ref, without your hooks, gc or index lock; `--read-only` keeps a repo untouched. To migrate an instance, copy its kept files into the forge with `git --git-dir=<instance>/forge/origin.git fetch <instance>/data/mirror.git '+refs/agentgraph/runs/*:refs/agentgraph/runs/*'`, then move `mirror.git` aside.
