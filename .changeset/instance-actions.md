---
'@jannik-stacks/agi': patch
---

Instance actions are one typed RPC group that the studio serves at `/api/actions` and the CLI calls in process through the same codec: `agi show`, `say`, `review`, `merge`, `close`, `export`, `prune-logs`, `resume`, `dispatch` and `check --runs`, and the run, results, log and verdict reads of the studio pages. `agi` follows a drive through a `watch` stream that sends a run list only when it changes. Every call carries the studio login's user and is refused without one. The `/api/runs`, `/api/results`, `/api/logs` and `/api/verdicts` routes are gone. `InstanceHost` moves from `@jannik-stacks/agi/trackers` to `@jannik-stacks/agi/plugins`.
