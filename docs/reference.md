# The graph folder

`.agentgraph/` holds Markdown files. Frontmatter configures the engine; file bodies instruct agents.

```text
.agentgraph/
  settings.yaml          settings
  agents/implementor.md  agents
  skills/implement.md    instructions
  checks/tests.md        checks
  workflows/issue.md     workflows
  scripts/               commands
  plugins/issues.ts      host plugins
```

`agi check --dir <dir>` validates graphs. Unknown keys, invalid references and unsupported values fail. Optional `fixtures/` holds fixtures. <!-- code: src/folder.ts#Graph src/folder.ts#loadGraph src/folder.ts#compile src/folder.ts#retiredIn src/workflow.ts#compileWorkflow -->

## Which graph runs

Locally, the engine uses the first graph it finds in this order: <!-- code: src/instance.ts#ensureGraph -->

1. `--dir <dir>` or `AGENTGRAPH_DIR`; explicit selection includes uncommitted edits.
2. Committed `.agentgraph/` at the base. Uncommitted graph edits produce a warning.
3. Working-tree `.agentgraph/` if the base does not track it. The banner says `graph .agentgraph/ (not in git)`.

The banner identifies the selected graph. <!-- code: src/instance.ts#whyGraphUncommitted src/instance.ts#formatGraphName -->

Without a graph, the engine stops with copy instructions; see [First run](local.md#first-run). `agi show graph` prints the selected graph and its files.

Committed graphs containing symlinks or submodules are refused. Each loop pass reloads the graph from the instance base branch. Inside the sandbox, `AGENTGRAPH_DIR` names the read-only graph copy. <!-- code: src/instance.ts#ensureGraph src/instance.ts#formatGraphName bin/run.ts#serve src/sandbox.ts#inside -->

## settings.yaml

| Field | Type; default | Meaning |
| --- | --- | --- |
| `setup` | Shell; absent | [Dependencies](sandbox.md#environments) |
| `toolchain` | Shell; absent | [Tool installs](sandbox.md#toolchains) |
| `image` | Local image; `agentgraph-sandbox:local` | Command image |
| `network` | `egress`, `models`; `egress` | [Network](sandbox.md#the-network) |
| `stacks` | Boolean; `false` | [Stacking](proposals.md#stacks-on-and-depends-on) |
| `milestone` | Title; absent | New-run scope; absent includes every open issue |
| `commands` | Map to `true`, `false` or logins; each `true` | [Command authorization](workflows.md#commands) within `trust` |
| `status` | Status-to-name map or `false`; `agent:<status>` | [Tracker status](workflows.md#status-on-the-issue) |
| `auth` | Plugin name; `token` | [Studio auth](plugins.md#auth); host graphs only |
| `plugins` | Map; absent | Plugin `settingsSchema` input |
| `limits` | Map; below | Resource caps |

<!-- code: src/folder.ts#GraphSettings src/docker.ts#sandboxImage src/workflow.ts#CommandSettings src/workflow.ts#commandVerbs src/event.ts#issueStatuses src/tracker.ts#makeStatusLabel src/services.ts#pickAuth src/plugin.ts#readPlugins --> <!-- code: src/services.ts#pickAuth -->

`limits`: <!-- code: src/folder.ts#Limits src/types.ts#CommandLimits src/docker.ts#limits -->

| Field | Type; default | Range or scope |
| --- | --- | --- |
| `memory` | Docker size; `4g` | `6m` to `64g`, per command |
| `cpus` | Number; 1.5 | 0.01 to 64, per command |
| `minutes` | Number; 30 | Above 0, per session, script or setup |
| `usd-per-run` | Number; 10 | Above 0, per run |
| `max` | Map; absent | Issue-label ceilings for `minutes` and `usd-per-run`; each defaults to its limit above |
| `parallel` | Integer; 2 | At least 1, concurrent runs; routers exempt |
| `sessions` | Integer; 4 | At least 1; concurrent sessions, scripts and judges per instance |

<!-- code: src/run/execute.ts#sessionPermitsRef -->

Step `limits` override the specified `memory` and `cpus` fields. See [shared permits](workflows.md#order-and-limits) and [`box` restrictions](sandbox.md#runners). <!-- code: src/types.ts#CommandLimits src/remote.ts#whyBoxRefused src/run/check.ts#runStepChecks --> <!-- code: src/run/execute.ts#runShell src/run/execute.ts#runSession src/run/execute.ts#sessionPermitsRef src/run/check.ts#runStepChecks -->

## Workflows

`workflows/<name>.md` defines a workflow named after the file. Its body describes the workflow or prompts its single step. <!-- code: src/workflow.ts#Front src/workflow.ts#compileWorkflow -->

| Field | Type; default |
| --- | --- |
| `on` | Required event or trigger map: `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback`, `conflict` |
| `branch` | Template expanding `{issue}`, `{parent}`; absent means detached checkout |
| `base` | Template; instance base, else repository default branch |
| `concurrency` | `steer`, `queue`, `cancel`; `steer` ([behavior](workflows.md#comments-while-it-works)) |
| `agent` | Agent name without `steps`; graph's only agent |
| `steps` | Ordered step map; one agent step named after file |
| `checks` | Check-name list; none ([end checks](checks.md#end-checks)) |

The `issues`, `issue_comment` and `pull_request` triggers hold: <!-- code: src/workflow.ts#Trigger -->

| Field | Type; meaning |
| --- | --- |
| `label` | Label name; adding starts work |
| `column` | Board Status option; entering starts work, also adds configured label |
| `project` | `owner/number`; unset reads any repo-owner board |
| `branches` | Name list; starts nothing |

See [Project boards](workflows.md#project-boards).

`dispatch` has no fields and permits [agent dispatch](workflows.md#dispatch). Humans can dispatch any workflow.

`feedback` starts [retros](workflows.md#retros). Optional `restarts: true` includes runs stopped by restart; it defaults to `false`. <!-- code: src/run/trigger.ts#feedback src/run/hear.ts#findSettledRuns src/workflow.ts#Front -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow -->

| Field | Type; default | Meaning |
| --- | --- | --- |
| `agent` | Agent name; absent | Session step |
| `run` | Shell; absent | Script step |
| `returns` | Proposal-kind list; `[run]` | `run` only; [grants](proposals.md) |
| `wait` | `human`; absent | Wait for person |
| `reads` | `traces`; absent | `run` only; [trace access](checks.md#reading-traces) |
| `carry` | Boolean; `false` | Pass successful reply forward |
| `skill` | Skill name; step name | Instructions |
| `checks` | Check-name list; none | After each try; at `wait`, after base update; defaults there to `back` step's script checks |
| `limits` | Map of `memory` and `cpus`; graph limits | Resources for the step and its checks |
| `tries` | Positive integer | Attempts including first; 1 at `wait`, otherwise 3 with checks, else 1 |
| `back` | Step name; absent | This or earlier step |
| `until` | Sentence | Required for agent with `back` |
| `rounds` | Positive integer; 3 | Return cap; uncapped at `wait` |
| `each` | `files`, `hunks`, command; absent | Session per item; above 20, one handles all |
| `follow` | `merge`, `rebase`, `none`; `merge` | `wait` only; [base following](workflows.md#when-the-base-or-the-graph-moves) |
| `conflict` | `back`, `ask`, workflow name | `wait` only; defaults to `on: conflict` workflow, else `back` if configured, else `ask` |

<!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow --> <!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow -->

## Agents

`agents/<name>.md`. The body is added to the harness's system prompt. <!-- code: src/types.ts#Agent -->

| Field | Type; default |
| --- | --- |
| `harness` | [Harness name](sandbox.md#harnesses); provider's first, else config's first |
| `model` | Model alias; `default`, or Claude Code's own |
| `tools` | Built-in and [plugin tool](plugins.md) names; none |
| `returns` | [Proposal kinds](proposals.md); `[comment]` |
| `reads` | `traces`; absent; needs file-reading tool |
| `session` | `fresh`, `same`; unset |

### Sessions

Without `session`, a step reuses its session across tries, `back`, answers and asides. Forward re-entry starts a new session. Steps with `each` and judges start fresh per item.

`session: same` keeps one session per run for each step or check. Steps retain it through forward re-entry and receive the branch diff again. Steps with `each` process items as sequential turns. Judges reuse one session per check across items, tries and rounds. On later tries, they are told the change may have moved.

`session: fresh` starts a new session each time. [Judges missing results](checks.md#judges) still resume once.

If resuming fails before the harness starts, or another harness ran the session, the engine retries once fresh with the full prompt. <!-- code: src/run/attempt.ts#runAttempt src/run/check.ts#runOneCheck src/workflow.ts#transition -->

## Checks

`checks/<name>.md`, with `run`, `agent` or both. The body is its description; see [Checks and results](checks.md). <!-- code: src/types.ts#Check src/result.ts#CheckMode src/run/checkout.ts#findFanOutItems src/run/checkout.ts#most -->

| Field | Type; default |
| --- | --- |
| `mode` | Required: `info`, `warn`, `block`, `stop` ([behavior](checks.md)) |
| `run` | Shell; absent; without own `returns`, exit 0 passes |
| `agent` | Agent name; absent; judges through the `result` tool |
| `each` | `files`, `hunks`, `merged`, command; absent; `merged` means hunks gained from base |
| `max` | Positive integer; 20; excess items fail |
| `returns` | JSON Schema subset; `{pass, why}` |
| `pass` | JSON Schema subset; `pass` equals `true`; forbidden on `info` |
| `reads` | `traces`; absent; [works on old runs](checks.md#end-checks) |

The schema supports `type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum` and `description`. Numeric fields may set a display `unit`: `usd`, `minutes`, `seconds`, `tokens` or `share`. <!-- code: src/result.ts#ResultType -->

The roots of `returns` and `pass` allow only `type: object`, `properties` and `required`. A field with `type` accepts only keywords for that type: objects use `properties` and `required`, arrays use `items`, and numbers and integers use `minimum` and `maximum`. Without `type`, each keyword applies only to values it fits. `enum` and `const` compare content, ignoring key order. <!-- code: src/types.ts#ResultRoot src/result.ts#findMismatch -->

## Skills

`skills/<name>.md` or `skills/<name>/SKILL.md`. The body is the instruction; other frontmatter keys are ignored. <!-- code: src/folder.ts#SkillFile -->

| Field | Type; default | Meaning |
| --- | --- | --- |
| `description` | Text; absent | Purpose |
| `uses` | Skill-name list; absent | Bodies appended in listed order |
