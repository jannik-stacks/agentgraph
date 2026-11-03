---
'@jannik-stacks/agi': patch
---

The studio run list loads a summary of each run instead of its whole trace, about a fifth of the bytes for a busy data dir. A run's steps load when its row is opened, and the graph loads the picked run's lines on demand.
