---
'@jannik-stacks/agi': patch
---

The studio's `runs`, `run` and `results` actions now answer with typed, checked responses. `runs` lists runs and `run` opens one by id. A check's `returns` and `pass` must describe an object, a field's keywords must suit its type, and `enum` and `const` compare values by content.
