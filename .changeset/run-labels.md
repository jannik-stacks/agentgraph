---
'@jannik-stacks/agi': patch
---

Runs take labels: free `key=value` metadata set with `agi start --label k=v`, `start({ labels })` or `agi label <run id> k=v k-` at any time. The issue-label flag of `start` and `say` is now `--issue-label`.
