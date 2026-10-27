---
'@jannik-stacks/agi': patch
---

A GitHub read that a narrowed App token is refused with a 404 is tried once more with a new token, so pull requests and file contents in a private repo stay readable. A merged pull request that can't be read, or one issue GitHub refuses, no longer stops the whole pass.
