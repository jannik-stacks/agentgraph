---
'@jannik-stacks/agi': patch
---

The sandbox image and the deploy engine image move to Debian trixie for git 2.47. The engine merges with `git merge-tree --merge-base`, which needs git 2.40 or later, so rebases failed in the deploy image and agentgraph's own tests failed in the sandbox. The sandbox image also gets jq. Rebuild `agentgraph-sandbox:local` to pick both up.
