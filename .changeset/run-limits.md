---
'@jannik-stacks/agi': patch
---

Runs read `agent:usd-per-run:<n>` and `agent:minutes:<n>` labels up to `limits.max`, and wait instead of stopping at their limits until a label or reply moves them on. Status labels default to `agent:`, agents cannot add or remove `agent:` labels, and folder-tracker frontmatter label edits become label events.
