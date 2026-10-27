# The graph folder

A repo keeps its graph in `.agentgraph/`: Markdown files whose frontmatter the engine reads and whose prose agents read.

```
.agentgraph/
  settings.yaml          repo, setup and limits
  agents/implementor.md  role, harness, model, tools, allowed proposals
  skills/implement.md    instructions handed to an agent
  checks/tests.md        a script or a judge
  workflows/issue.md     triggers and steps
  scripts/               anything checks and steps run
```

`agi check --dir <dir>` validates a graph. It fails on an unknown key, a missing or unused agent, check or skill, a duplicate name, an end check that is not `info` or `warn`, an unknown proposal kind, and retired words. A graph may also hold `fixtures/`. <!-- code: src/folder.ts#loadGraph -->

Nothing here is stable yet; `CHANGELOG.md` lists renames and removals.

## Which graph runs

Locally, the first that exists: <!-- code: src/instance.ts#ensureGraph src/instance.ts#defaultDir -->

1. `--dir <dir>`, or `AGENTGRAPH_DIR`; `--dir .agentgraph` uses your working tree, uncommitted edits included.
2. `.agentgraph/` in your repo at the committed base.
3. `.agentgraph/` in your working tree when the base does not track it. The start banner says `graph .agentgraph/ (not in git)`.
4. The default graph in the package: implement, review, then a human merge, with a check that runs the repo's `test` script if it has one. To change it, copy the folder `agi show graph` prints to `.agentgraph/`.

To keep a private graph out of a team repo, add `.agentgraph/` to `.git/info/exclude`. Git then ignores it without a change to `.gitignore`, and every command reads it from disk. <!-- code: src/instance.ts#formatGraphName -->

A committed graph with symlinks or submodules is refused. On GitHub, the runner reads `.agentgraph/` (or `AGENTGRAPH_DIR`, which may be an absolute path) from the default branch's head on every poll, so a pull request's graph changes apply after merge. Inside the sandbox `AGENTGRAPH_DIR` names the read-only copy of the graph. <!-- code: src/services.ts#graphAt src/main.ts#start -->

## settings.yaml

<!-- code: src/folder.ts#SettingsFile -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `repo` | `owner/name` | none | GitHub repo |
| `setup` | shell script | none | Dependency install; see [Environments](sandbox.md#environments) |
| `toolchain` | shell script | none | Extra tool installs; see [Toolchains](sandbox.md#toolchains) |
| `image` | local image name | `agentgraph-sandbox:local` | Base image for run commands |
| `network` | `egress` or `models` | `egress` | What sessions and setup reach; see [The network](sandbox.md#the-network) |
| `stacks` | boolean | `false` | Stacked pull requests; see [Proposals](proposals.md#stacks-on-and-depends-on) |
| `milestone` | milestone title | none, every open issue | Scope for new runs |
| `trust` | list of logins | owners, members and collaborators | Who may steer the bot |
| `limits` | map | below | Caps on a run |

`limits`: <!-- code: src/folder.ts#Limits -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `minutes` | number | 30 | Deadline per session, script or setup |
| `usd-per-run` | number | 10 | Spend cap per run |
| `parallel` | integer | 2 | Concurrent runs |
| `sessions` | integer | 4 | Concurrent sessions across runs, judges included <!-- code: src/engine.ts#getSessionGate --> |

## Workflows

`workflows/<name>.md`, named by its file. The body describes it, or is the prompt of its single step. <!-- code: src/workflow.ts#Front -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `on` | event name, or map of triggers | required | `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback` or `conflict` |
| `branch` | template | none, a detached checkout | Work branch; expands `{issue}` and `{parent}` |
| `base` | template | `main` | Pull request base |
| `concurrency` | `steer`, `queue` or `cancel` | `steer` | [Comments while it works](workflows.md#comments-while-it-works) |
| `agent` | agent name | the graph's only agent | Agent when there are no `steps` |
| `steps` | map of step name to step | one agent step named after the file | Steps in written order |
| `checks` | list of check names | none | [End checks](checks.md#end-checks) |

A trigger under `on` holds: <!-- code: src/workflow.ts#Trigger -->

| Field | Type | Meaning |
| --- | --- | --- |
| `label` | label name | Adding it to an issue starts a run |
| `branches` | list of names | Accepted, starts nothing yet |

`dispatch` and `feedback` take no fields: `on: { issues: { label: triage }, dispatch }`. See [Dispatch](workflows.md#dispatch) and [Retros](workflows.md#retros). <!-- code: src/engine.ts#feedback -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile -->

| Field | Type | Default | Meaning |
| --- | --- | --- | --- |
| `agent` | agent name | none | An agent runs the step in a session |
| `run` | shell command | none | A script runs the step |
| `wait` | `human` | none | The step waits for a person |
| `skill` | skill name | the skill named like the step | Agent instructions |
| `checks` | list of check names | none; at `wait`, its `back` step's script checks | Checks after each try; at `wait`, after a base update |
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
| `tools` | list of tool names | none | Allowed tools |
| `returns` | list of proposal kinds | `[comment]` | What it may [propose](proposals.md) |
| `reads` | `traces` | none | [The issue's run traces](checks.md#reading-traces); needs the `read` tool |

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
