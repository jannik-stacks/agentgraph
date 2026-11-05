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
  plugins/issues.ts      reviewed host tools
```

`agi check --dir <dir>` validates a graph. It fails on an unknown key, a missing or unused agent, check or skill, a duplicate name, an end check that is not `info` or `warn`, an unknown proposal kind, and retired words. A graph may also hold `fixtures/`. <!-- code: src/folder.ts#loadGraph -->

Nothing here is stable yet; `CHANGELOG.md` lists renames and removals.

## Which graph runs

Locally, the first that exists: <!-- code: src/instance.ts#ensureGraph -->

1. `--dir <dir>`, or `AGENTGRAPH_DIR`; `--dir .agentgraph` uses your working tree, uncommitted edits included.
2. `.agentgraph/` in your repo at the committed base.
3. `.agentgraph/` in your working tree when the base does not track it. The start banner says `graph .agentgraph/ (not in git)`.

Without a graph, the engine stops and tells you how to copy an example. See [First run](local.md#first-run). `agi show graph` prints the graph you selected and its files.

To keep a private graph out of a team repo, add `.agentgraph/` to `.git/info/exclude`. Git then ignores it without a change to `.gitignore`, and every command reads it from disk. <!-- code: src/instance.ts#formatGraphName -->

A committed graph with symlinks or submodules is refused. The loop reads `.agentgraph/` from the instance base branch on every pass, so a pull request's graph changes apply once they reach that branch in the instance checkout. Inside the sandbox `AGENTGRAPH_DIR` names the read-only copy of the graph. <!-- code: src/instance.ts#ensureGraph bin/run.ts#loop -->

## settings.yaml

<!-- code: src/folder.ts#GraphSettings -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `setup` | shell script | none | Dependency install; see [Environments](sandbox.md#environments) |
| `toolchain` | shell script | none | Extra tool installs; see [Toolchains](sandbox.md#toolchains) |
| `image` | local image name | `agentgraph-sandbox:local` | Base image for run commands |
| `network` | `egress` or `models` | `egress` | What sessions and setup reach; see [The network](sandbox.md#the-network) |
| `stacks` | boolean | `false` | Stacked pull requests; see [Proposals](proposals.md#stacks-on-and-depends-on) |
| `milestone` | milestone title | none, every open issue | Scope for new runs |
| `commands` | map of command or comment workflow to `true`, `false` or logins | `true` for each | Who in `trust` may use each [`/agent:` command](workflows.md#commands) |
| `status` | map of status to name, or `false` | `agentgraph:<status>` | How the tracker shows each [status](workflows.md#status-on-the-issue) |
| `plugins` | map | none | Settings decoded by each [plugin's](plugins.md) `settingsSchema` |
| `limits` | map | below | Caps on a run |

`limits`: <!-- code: src/folder.ts#Limits -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `memory` | Docker size string | `4g` | Memory per Docker command, from `6m` to `64g` |
| `cpus` | number | 1.5 | CPUs per Docker command, from 0.01 to 64 |
| `minutes` | number | 30 | Deadline per session, script or setup |
| `usd-per-run` | number | 10 | Spend cap per run |
| `parallel` | integer | 2 | Concurrent runs |
| `sessions` | integer | 4 | Concurrent sessions and scripts across the process, judges included <!-- code: src/run/execute.ts#getGate --> |

Memory sizes use integer bytes or a `b`, `k`, `m` or `g` suffix (case insensitive). Remote boxes reject resource overrides. Step `limits` override only the named fields; other steps keep the graph limits.

Sessions, script checks, fan-out commands and setup share permits. Each releases its permit before checks or judges start. If graphs set different limits, the process keeps the smallest limit it has seen. Check findings still return together after every check settles. <!-- code: src/run/execute.ts#runShell src/run/execute.ts#runSession src/run/execute.ts#getGate src/run/check.ts#runStepChecks -->

## Workflows

`workflows/<name>.md`, named by its file. The body describes it, or is the prompt of its single step. <!-- code: src/workflow.ts#Front -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `on` | event name, or map of triggers | required | `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback` or `conflict` |
| `branch` | template | none, a detached checkout | Work branch; expands `{issue}` and `{parent}` |
| `base` | template | instance base, else repository default branch | Pull request base |
| `concurrency` | `steer`, `queue` or `cancel` | `steer` | [Comments while it works](workflows.md#comments-while-it-works) |
| `agent` | agent name | the graph's only agent | Agent when there are no `steps` |
| `steps` | map of step name to step | one agent step named after the file | Steps in written order |
| `checks` | list of check names | none | [End checks](checks.md#end-checks) |

A trigger under `on` holds: <!-- code: src/workflow.ts#Trigger -->

| Field | Type | Meaning |
| --- | --- | --- |
| `label` | label name | Adding it to an issue starts a run |
| `column` | option of a board's Status field | The issue's card in that column starts a run; with `label`, also adds the label ([Project boards](workflows.md#project-boards)) |
| `project` | `owner/number` | The one board `column` reads; any board of the repo owner when unset |
| `branches` | list of names | Accepted, starts nothing yet |

`dispatch` and `feedback` take no fields: `on: { issues: { label: triage }, dispatch }`. `dispatch` lets an agent's `run` proposal start the workflow; a human can dispatch any workflow. `feedback` starts on what people say or push where a run worked and on each run that ends. See [Dispatch](workflows.md#dispatch) and [Retros](workflows.md#retros). <!-- code: src/run/trigger.ts#feedback -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agent` | agent name | none | An agent runs the step in a session |
| `run` | shell command | none | A script runs the step |
| `returns` | list of proposal kinds | `[run]`, `run` steps only | What its script may [propose](proposals.md) |
| `wait` | `human` | none | The step waits for a person |
| `skill` | skill name | the skill named like the step | Agent instructions |
| `checks` | list of check names | none; at `wait`, its `back` step's script checks | Checks after each try; at `wait`, after a base update |
| `limits` | map of `memory` and `cpus` | graph limits | Resource overrides for the step and its checks |
| `tries` | positive integer | 1 at `wait`, else 3 with checks, else 1 | Attempts, the first included |
| `back` | step name | none | This or an earlier step the run may return to |
| `until` | sentence | required on an agent step with `back` | When the step is done |
| `rounds` | positive integer | 3, no cap at `wait` | Cap on returns |
| `each` | `files`, `hunks` or `{ run: <command> }` | none | One fresh session per item; past 20 items, one session for all |
| `follow` | `merge`, `rebase` or `none` | `merge`, `wait` steps only | How the branch [follows a moved base](workflows.md#when-the-base-or-the-graph-moves) |

## Agents

`agents/<name>.md`. The body is added to the harness's system prompt. <!-- code: src/folder.ts#Agent -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `harness` | harness name | the provider's first, else the config's first | See [Harnesses](sandbox.md#harnesses) |
| `model` | model alias | `default`, or Claude Code's own | The model name the endpoint expects |
| `tools` | list of tool names | none | Allowed harness built-ins and [plugin tools](plugins.md) |
| `returns` | list of proposal kinds | `[comment]` | What it may [propose](proposals.md) |
| `reads` | `traces` | none | [The issue's run traces](checks.md#reading-traces); needs a tool that can read files |

## Checks

`checks/<name>.md`, with `run`, `agent` or both. The body is its description; see [Checks and results](checks.md). <!-- code: src/folder.ts#Check -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `mode` | `info`, `warn`, `block` or `stop` | required | What a failure does |
| `run` | shell command | none | A script; without its own `returns`, exit 0 passes |
| `agent` | agent name | none | A judge; it records its result with the `result` tool |
| `each` | `files`, `hunks` or a command | none | Judge each item on its own |
| `max` | positive integer | 20 | Item cap; more fail |
| `returns` | JSON Schema subset | `{pass, why}` | The result's shape |
| `pass` | JSON Schema subset | `pass` is true | The results that pass; not on `info` |
| `reads` | `traces` | none | Needs only the run's traces, so it runs on old runs |

The schema subset has `type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum` and `description`. A number field may name a display `unit`: `usd`, `minutes`, `seconds`, `tokens` or `share`.

## Skills

`skills/<name>.md` or `skills/<name>/SKILL.md`. The body is the instruction; other frontmatter keys are ignored. <!-- code: src/folder.ts#SkillFile -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `description` | text | none | What the skill is for |
| `uses` | list of skill names | none | Skills whose bodies follow this one in the prompt |
