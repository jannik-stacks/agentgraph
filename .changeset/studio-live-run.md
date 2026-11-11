---
'@jannik-stacks/agi': patch
---

The studio run page follows only its own run: a finished run stops refetching, a live run fetches only the trace lines it has not seen (`run` takes `after`), and only the newest rows re-render. A request the server fails on shows its message instead of loading forever.
