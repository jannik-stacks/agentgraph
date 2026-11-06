---
'@jannik-stacks/agi': patch
---

`agi stop` and `agi restart` stop a loop and wait until it lets go, and `agi loop --detach` runs it in the background with a log under `<data root>/logs/`. The loop lock is now one per checkout, so a second loop on a checkout fails with the commands to run or waits while the first is stopping, and a lock whose holder died on this host is free at once.
