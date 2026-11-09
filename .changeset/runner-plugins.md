---
'@jannik-stacks/agi': patch
---

Commands run through a runner picked like a tracker: `--runner`, `AGENTGRAPH_RUNNER` or `runner:` in instance.yaml, `local` by default. `local` and `box` ship in `@jannik-stacks/agi/runners` with `makeBoxRunner`, a graph plugin can add its own, and `agi check` and the loop say what in a graph the runner cannot run. `AGENTGRAPH_SANDBOX_URL` alone no longer picks the box server; set `AGENTGRAPH_RUNNER=box` too. `examples/plugins/modal/` runs boxes on Modal.
