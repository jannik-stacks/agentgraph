---
'@jannik-stacks/agi': patch
---

The loop sends far fewer GitHub requests: a scan reads each closed or merged issue once instead of once per issue it looks at, tokens, ETags and write permissions last across passes, and a rate-limited request waits for the reset with one warning instead of failing every call.
