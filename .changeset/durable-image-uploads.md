---
'@jannik-stacks/agi': patch
---

Persist uploaded images by hash before acknowledging them, and record their hash and session in the trace. Keep image bytes after sessions close while preserving session handle limits.
