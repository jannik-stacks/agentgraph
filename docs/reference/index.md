# Reference

The types and functions that define each part of bothub.

Each page shows the few types and functions an area is built around, read from the source when the
docs are built. A block's header names the file and lines and opens them in VS Code; a chip like

`runPlan` shows its summary on hover. The conventions all of them follow are on [Patterns](../patterns.md).

| Page                                            | Defined by                                                                       |
| ----------------------------------------------- | -------------------------------------------------------------------------------- |
| [Hub config](config.md)            | `Bot`, `Job`, `Config`                    |
| [Pipeline and checks](pipeline.md) | `PlannedJob`, `Verdict`, `failingChecks`  |
| [Proposals](proposals.md)          | `Proposal`, `validate`, `ApplyResult`     |
| [Runs](runs.md)                    | `Run`, `runJob`, `reconcile`              |
| [Harnesses](harnesses.md)          | `RunSpec`, `AgentEvent`, `HarnessAdapter` |
| [Issues and context](context.md)   | `Issues`, `weigh`, `serveMcp`             |
| [Events and serving](serve.md)     | `BotEvent`, `serveHub`, `Scenario`        |

## How one event flows

```
BotEvent → plan → runPlan → runPlanned → attempts → runJob (harness) → checks → validate → apply
```

An event comes from a webhook, a message to the local forge or the CLI and is normalised into a

`BotEvent`. `plan` plans the jobs it starts, `runPlan`
runs them in dependency order, and each bot job loops through attempts until its checks pass. Proposals from the final
attempt are validated and applied, and everything lands in the [run store](runs.md).
