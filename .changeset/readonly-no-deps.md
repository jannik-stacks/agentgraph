---
'@jannik-stacks/agi': patch
---

Runs whose agents only read, such as routers and triage, start without building or waiting for the repo's dependency environment and skip `setup`.
