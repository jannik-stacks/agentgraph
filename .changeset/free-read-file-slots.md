---
'@jannik-stacks/agi': patch
---

A successful file handle read now consumes the handle and frees its slot and held bytes, so sessions can upload more than 32 images over time while keeping the limits on unread files and cumulative input.
