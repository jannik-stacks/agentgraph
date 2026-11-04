---
'@jannik-stacks/agi': patch
---

Status hooks get `tracker.moveToColumn(issue, { project, name })` on GitHub instead of raw `tracker.graphql`. A plugin that sent its own GraphQL moves cards through this method now.
