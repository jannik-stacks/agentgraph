---
'@jannik-stacks/agi': patch
---

An instance refuses a folder path as its `tracker`, and the loop checks the tracker plugin again whenever the graph changes. A callback that resumes after its tracker lock was released waits for the lock again.
