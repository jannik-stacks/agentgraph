---
'@jannik-stacks/agi': patch
---

Agents take `session: fresh | same`. `same` keeps one session per run for each step or check the agent works in, across tries, backs and forward re-entry, and takes `each` items as turns of it; `fresh` starts a new session every time. Without it nothing changes. The studio shows a short session id and why a resume was dropped.
