---
'@jannik-stacks/agi': patch
---

Runs take labels: free `key=value` metadata set with `agi start --run-label k=v`, `start({ labels })` or `agi label <run id> k=v k-` at any time, kept as an append-only log in `<run id>/labels.jsonl`.
