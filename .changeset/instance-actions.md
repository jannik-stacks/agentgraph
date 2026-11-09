---
'@jannik-stacks/agi': patch
---

Instance actions are one typed RPC group. Studio pages call it through `runAction(a => a.say({ issue, text }))` instead of `runAction('say', issue, text)`, and `agi show`, `say`, `review`, `merge`, `close`, `resume`, `dispatch` and `check --runs` call the same group in process, so both decode input the same way. Every call carries the studio login's user and is refused without one. `InstanceHost` moves from `@jannik-stacks/agi/trackers` to `@jannik-stacks/agi/plugins`.
