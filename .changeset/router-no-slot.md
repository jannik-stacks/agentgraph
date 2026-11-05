---
'@jannik-stacks/agi': patch
---

Router runs no longer wait for a `limits.parallel` slot, so a comment is routed while long runs hold every slot. `limits.sessions` still bounds their sessions.
