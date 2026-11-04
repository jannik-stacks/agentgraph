---
'@jannik-stacks/agi': patch
---

A tune scores each candidate as labelled bench runs (`tune=<name>`, `cand=<id>`) in the tune dir's `runs/`, through `bin/bench.ts --graph`. `tune/propose.ts --runs` is now `--cand <id>`.
