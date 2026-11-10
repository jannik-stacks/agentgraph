# The graph folder

A repo keeps its graph in `.agentgraph/`: Markdown files whose frontmatter the engine reads and whose prose agents read.

```
.agentgraph/
  settings.yaml          setup and limits
  agents/implementor.md  role, harness, model, tools, allowed proposals
  skills/implement.md    instructions handed to an agent
  checks/tests.md        a script or a judge
  workflows/issue.md     triggers and steps
  scripts/               anything checks and steps run
  plugins/issues.ts      reviewed tools, hooks and host plugins
```

`agi check --dir <dir>` validates a graph. Unknown keys, invalid references and unsupported values fail validation. A graph may also hold `fixtures/`. <!-- code: src/folder.ts#Graph src/folder.ts#loadGraph src/folder.ts#compile src/folder.ts#retiredIn src/workflow.ts#compileWorkflow -->

## Which graph runs

Locally, the first that exists: <!-- code: src/instance.ts#ensureGraph -->

1. `--dir <dir>`, or `AGENTGRAPH_DIR`; `--dir .agentgraph` uses your working tree, uncommitted edits included.
2. `.agentgraph/` in your repo at the committed base.
3. `.agentgraph/` in your working tree when the base does not track it. The start banner says `graph .agentgraph/ (not in git)`.

Without a graph, the engine stops and tells you how to copy an example. See [First run](local.md#first-run). `agi show graph` prints the graph you selected and its files.

A committed graph with symlinks or submodules is refused. The loop reads `.agentgraph/` from the instance base branch on every pass, so a pull request's graph changes apply once they reach that branch in the instance checkout. Inside the sandbox `AGENTGRAPH_DIR` names the read-only copy of the graph. <!-- code: src/instance.ts#ensureGraph src/instance.ts#formatGraphName bin/run.ts#serve src/sandbox.ts#inside -->

## settings.yaml

<!-- code: src/folder.ts#GraphSettings src/docker.ts#sandboxImage src/workflow.ts#CommandSettings src/workflow.ts#commandVerbs src/event.ts#issueStatuses src/tracker.ts#makeStatusLabel src/services.ts#pickAuth src/plugin.ts#readPlugins -->

| Field       | Type                                                            | Default                    | Meaning                                                                                                                                     |
| ----------- | --------------------------------------------------------------- | -------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `setup`     | shell script                                                    | none                       | Dependency install; see [Environments](sandbox.md#environments)                                                                             |
| `toolchain` | shell script                                                    | none                       | Extra tool installs; see [Toolchains](sandbox.md#toolchains)                                                                                |
| `image`     | local image name                                                | `agentgraph-sandbox:local` | Base image for run commands                                                                                                                 |
| `network`   | `egress` or `models`                                            | `egress`                   | What sessions and setup reach; see [The network](sandbox.md#the-network)                                                                    |
| `stacks`    | boolean                                                         | `false`                    | Stacked pull requests; see [Proposals](proposals.md#stacks-on-and-depends-on)                                                               |
| `milestone` | milestone title                                                 | none, every open issue     | Scope for new runs                                                                                                                          |
| `commands`  | map of command or comment workflow to `true`, `false` or logins | `true` for each            | Who in `trust` may use each [`/agent:` command](workflows.md#commands)                                                                      |
| `status`    | map of status to name, or `false`                               | `agentgraph:<status>`      | How the tracker shows each [status](workflows.md#status-on-the-issue)                                                                       |
| `auth`      | auth plugin name                                                | `token`                    | Host graph only: who may open the studio; repo graphs cannot pick auth; see [Auth](plugins.md#auth) <!-- code: src/services.ts#pickAuth --> |
| `plugins`   | map                                                             | none                       | Settings decoded by each [plugin's](plugins.md) `settingsSchema`                                                                            |
| `limits`    | map                                                             | below                      | Caps on a run                                                                                                                               |

`limits`: <!-- code: src/folder.ts#Limits src/types.ts#CommandLimits src/docker.ts#limits -->

| Field         | Type               | Default | Meaning                                                                                                              |
| ------------- | ------------------ | ------- | -------------------------------------------------------------------------------------------------------------------- |
| `memory`      | Docker size string | `4g`    | Memory per Docker command, from `6m` to `64g`                                                                        |
| `cpus`        | number             | 1.5     | CPUs per Docker command, from 0.01 to 64                                                                             |
| `minutes`     | number             | 30      | Deadline per session, script or setup                                                                                |
| `usd-per-run` | number             | 10      | Spend cap per run                                                                                                    |
| `parallel`    | integer            | 2       | Concurrent runs; router runs take no slot                                                                            |
| `sessions`    | integer            | 4       | Concurrent sessions and scripts of one instance, judges included <!-- code: src/run/execute.ts#sessionPermitsRef --> |

Step `limits` override named memory and CPU fields. Sessions, scripts and judges share per-instance permits. The `box` runner rejects resource overrides, graph images and host tools. <!-- code: src/types.ts#CommandLimits src/remote.ts#whyBoxRefused src/run/check.ts#runStepChecks --> <!-- code: src/run/execute.ts#runShell src/run/execute.ts#runSession src/run/execute.ts#sessionPermitsRef src/run/check.ts#runStepChecks -->

## Workflows

`workflows/<name>.md`, named by its file. The body describes it, or is the prompt of its single step. <!-- code: src/workflow.ts#Front src/workflow.ts#compileWorkflow -->

| Field         | Type                           | Default                                       | Meaning                                                                         |
| ------------- | ------------------------------ | --------------------------------------------- | ------------------------------------------------------------------------------- |
| `on`          | event name, or map of triggers | required                                      | `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback` or `conflict` |
| `branch`      | template                       | none, a detached checkout                     | Work branch; expands `{issue}` and `{parent}`                                   |
| `base`        | template                       | instance base, else repository default branch | Pull request base                                                               |
| `concurrency` | `steer`, `queue` or `cancel`   | `steer`                                       | [Comments while it works](workflows.md#comments-while-it-works)                 |
| `agent`       | agent name                     | the graph's only agent                        | Agent when there are no `steps`                                                 |
| `steps`       | map of step name to step       | one agent step named after the file           | Steps in written order                                                          |
| `checks`      | list of check names            | none                                          | [End checks](checks.md#end-checks)                                              |

The `issues`, `issue_comment` and `pull_request` triggers hold: <!-- code: src/workflow.ts#Trigger -->

| Field      | Type                             | Meaning                                                                                                                         |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `label`    | label name                       | Adding it to an issue starts a run                                                                                              |
| `column`   | option of a board's Status field | The issue's card in that column starts a run; with `label`, also adds the label ([Project boards](workflows.md#project-boards)) |
| `project`  | `owner/number`                   | The one board `column` reads; any board of the repo owner when unset                                                            |
| `branches` | list of names                    | Accepted, starts nothing yet                                                                                                    |

`dispatch` takes no fields and permits agent dispatch; humans can dispatch any workflow. See [Dispatch](workflows.md#dispatch).

`feedback` starts a [retro](workflows.md#retros); optional `restarts: true` includes runs stopped by restart (default `false`). <!-- code: src/run/trigger.ts#feedback src/run/hear.ts#findSettledRuns src/workflow.ts#Front -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow -->

| Field      | Type                             | Default                                                                               | Meaning                                                                                                                                                                         |
| ---------- | -------------------------------- | ------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `agent`    | agent name                       | none                                                                                  | An agent runs the step in a session                                                                                                                                             |
| `run`      | shell command                    | none                                                                                  | A script runs the step                                                                                                                                                          |
| `returns`  | list of proposal kinds           | `[run]`, `run` steps only                                                             | What its script may [propose](proposals.md)                                                                                                                                     |
| `wait`     | `human`                          | none                                                                                  | The step waits for a person                                                                                                                                                     |
| `reads`    | `traces`, `run` steps only       | none                                                                                  | Read the issue's [run traces](checks.md#reading-traces) <!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow -->                                                 |
| `carry`    | boolean                          | `false`                                                                               | Pass a successful reply to the next step; see [Tries and going back](workflows.md#tries-and-going-back) <!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow --> |
| `skill`    | skill name                       | the skill named like the step                                                         | Agent instructions                                                                                                                                                              |
| `checks`   | list of check names              | none; at `wait`, its `back` step's script checks                                      | Checks after each try; at `wait`, after a base update                                                                                                                           |
| `limits`   | map of `memory` and `cpus`       | graph limits                                                                          | Resource overrides for the step and its checks                                                                                                                                  |
| `tries`    | positive integer                 | 1 at `wait`, else 3 with checks, else 1                                               | Attempts, the first included                                                                                                                                                    |
| `back`     | step name                        | none                                                                                  | This or an earlier step the run may return to                                                                                                                                   |
| `until`    | sentence                         | required on an agent step with `back`                                                 | When the step is done                                                                                                                                                           |
| `rounds`   | positive integer                 | 3, no cap at `wait`                                                                   | Cap on returns                                                                                                                                                                  |
| `each`     | `files`, `hunks` or a command    | none                                                                                  | One fresh session per item; past 20 items, one session for all                                                                                                                  |
| `follow`   | `merge`, `rebase` or `none`      | `merge`, `wait` steps only                                                            | How the branch [follows a moved base](workflows.md#when-the-base-or-the-graph-moves)                                                                                            |
| `conflict` | `back`, `ask` or a workflow name | the `on: conflict` workflow, else `back` with a `back`, else `ask`; `wait` steps only | What a conflict with a [moved base](workflows.md#when-the-base-or-the-graph-moves) does                                                                                         |

## Agents

`agents/<name>.md`. The body is added to the harness's system prompt. <!-- code: src/types.ts#Agent -->

| Field     | Type                   | Default                                       | Meaning                                                                              |
| --------- | ---------------------- | --------------------------------------------- | ------------------------------------------------------------------------------------ |
| `harness` | harness name           | the provider's first, else the config's first | See [Harnesses](sandbox.md#harnesses)                                                |
| `model`   | model alias            | `default`, or Claude Code's own               | The model name the endpoint expects                                                  |
| `tools`   | list of tool names     | none                                          | Allowed harness built-ins and [plugin tools](plugins.md)                             |
| `returns` | list of proposal kinds | `[comment]`                                   | What it may [propose](proposals.md)                                                  |
| `reads`   | `traces`               | none                                          | [The issue's run traces](checks.md#reading-traces); needs a tool that can read files |

## Checks

`checks/<name>.md`, with `run`, `agent` or both. The body is its description; see [Checks and results](checks.md). <!-- code: src/types.ts#Check src/result.ts#CheckMode src/run/checkout.ts#findFanOutItems src/run/checkout.ts#most -->

| Field     | Type                                    | Default        | Meaning                                                                                                                |
| --------- | --------------------------------------- | -------------- | ---------------------------------------------------------------------------------------------------------------------- |
| `mode`    | `info`, `warn`, `block` or `stop`       | required       | What a failure does                                                                                                    |
| `run`     | shell command                           | none           | A script; without its own `returns`, exit 0 passes                                                                     |
| `agent`   | agent name                              | none           | A judge; it records its result with the `result` tool                                                                  |
| `each`    | `files`, `hunks`, `merged` or a command | none           | Judge each item on its own; `merged` is each hunk a [base move](workflows.md#when-the-base-or-the-graph-moves) brought |
| `max`     | positive integer                        | 20             | Item cap; more fail                                                                                                    |
| `returns` | JSON Schema subset                      | `{pass, why}`  | The result's shape                                                                                                     |
| `pass`    | JSON Schema subset                      | `pass` is true | The results that pass; not on `info`                                                                                   |
| `reads`   | `traces`                                | none           | Needs only the run's traces, so it runs on old runs                                                                    |

The schema subset has `type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum` and `description`. A number field may name a display `unit`: `usd`, `minutes`, `seconds`, `tokens` or `share`. <!-- code: src/result.ts#ResultType -->

## Skills

`skills/<name>.md` or `skills/<name>/SKILL.md`. The body is the instruction; other frontmatter keys are ignored. <!-- code: src/folder.ts#SkillFile -->

| Field         | Type                | Default | Meaning                                           |
| ------------- | ------------------- | ------- | ------------------------------------------------- |
| `description` | text                | none    | What the skill is for                             |
| `uses`        | list of skill names | none    | Skills whose bodies follow this one in the prompt |
