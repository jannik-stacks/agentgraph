---
'@jannik-stacks/agi': patch
---

A command without `--instance` makes a new instance only when every other folder in the data root is an instance of another checkout; otherwise it stops and names the folders. `agi show` outside a repo skips an unreadable `instance.yaml` with a warning. An empty `AGENTGRAPH_PROVIDER` counts as unset, so the record's provider wins and is not overwritten.
