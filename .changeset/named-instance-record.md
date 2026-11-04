---
'@jannik-stacks/agi': patch
---

Choose instance names with `--instance` and keep checkout, tracker repository and trust in the instance record. Resolve command overrides consistently, including workflow bases.

Rename the instance checkout field to `checkout`, move graph `repo` and `trust` into the instance, and rename the instance folder to its chosen name; see “Migrating an existing instance” in docs/local.md. Graph settings now reject `repo` and `trust`.

Use the selected graph snapshot for tracker setup and execution, honor scoped preflight and explicit log flags, retain loop compression, and refresh studio graph paths on reload.

Hosted entrypoints select a provisioned named instance. Preserve committed graphs without a local tracker, prepare providers for dispatched work, release loop locks on service shutdown, and refresh cached studio pages.
