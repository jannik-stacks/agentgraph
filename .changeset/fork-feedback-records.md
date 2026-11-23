---
"@jannik-stacks/agi": patch
---

Fix fork push feedback parsing and keep Studio tracker credentials scoped to each instance.

Add a one-off migration for stored proposal results that used `ok` before the `status` field.

Preserve unrelated historical run and trace fields during the proposal-result migration. Read cleared-field history without requiring retired field names to exist in the current run schema.
