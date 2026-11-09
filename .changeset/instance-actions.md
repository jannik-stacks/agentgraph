---
'@jannik-stacks/agi': patch
---

Instance actions are one typed RPC group that the studio serves at `/api/actions` and the CLI calls in process through the same codec: `agi show`, `say`, `review`, `merge`, `close`, `resume`, `dispatch` and `check --runs`. Every call carries the studio login's user and is refused without one. The page helper `runAction` is gone. `InstanceHost` moves from `@jannik-stacks/agi/trackers` to `@jannik-stacks/agi/plugins`.
