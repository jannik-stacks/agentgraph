---
'@jannik-stacks/agi': patch
---

The studio sends live updates over Vite's own socket and names what changed, so a bench write no longer refetches the run list and many open tabs no longer stall requests. A failing request shows the server's error.
