# The graph folder

A graph folder holds settings and Markdown files for [agents, skills, checks and workflows](index.md#terms). The YAML frontmatter configures the engine. The text below it supplies instructions. <!-- code: src/folder.ts#loadGraph src/workflow.ts#splitFrontmatter -->

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

Run `agi check --dir <dir>` to validate a graph. It reports unknown keys, invalid references and unsupported values with their paths. It also checks how the files fit together. <!-- code: src/folder.ts#loadGraph src/folder.ts#compile src/workflow.ts#compileWorkflow -->

- Every agent, skill and check must be used. An extra top-level folder must be read through `$AGENTGRAPH_DIR` by a graph file. The loader recognizes the standard folders, including optional `fixtures/`, and ignores hidden folders. <!-- code: src/folder.ts#compile src/folder.ts#loadGraph src/folder.ts#folders -->
- An agent, skill or check body that names a proposal `kind` must use a kind supported in replies. Agent, skill, check and workflow files cannot contain retired terms. <!-- code: src/folder.ts#compile src/folder.ts#unknownKinds src/folder.ts#retiredIn src/proposal.ts#Kind -->
- Each `commands.<name>` key must name a command verb or a comment workflow. The command names `stop`, `cancel` and `restart` are reserved and cannot name workflow files. <!-- code: src/folder.ts#compile src/workflow.ts#compileWorkflow src/workflow.ts#commandVerbs -->
- A check's `pass` rule can read only fields its `returns` schema requires. <!-- code: src/result.ts#whyPassUndecided src/folder.ts#compile -->

## Which graph runs

On the host, the engine selects the graph in this order.

1. An explicit `--dir <dir>` or host `AGENTGRAPH_DIR` selects a folder, including its uncommitted edits.
2. If the base branch tracks `.agentgraph/`, the engine uses the committed graph and warns about uncommitted edits.
3. Otherwise the engine uses the working tree’s `.agentgraph/`. The banner says `graph .agentgraph/ (not in git)`. <!-- code: src/instance.ts#ensureGraph src/instance.ts#whyGraphUncommitted src/instance.ts#formatGraphName bin/run.ts -->

If the engine cannot find a graph, it gives [instructions for copying one](local.md#first-run). To see which graph and files it selected, use `agi show graph`. <!-- code: src/instance.ts#ensureGraph bin/run.ts -->

The engine refuses committed graphs containing symlinks or submodules. When the graph comes from the instance base branch, each loop pass reloads it. Inside the sandbox, `AGENTGRAPH_DIR` names the read-only graph copy. <!-- code: src/instance.ts#ensureGraph src/instance.ts#formatGraphName bin/run.ts#serve src/sandbox.ts#inside -->

## settings.yaml

| Field | Accepted value and default | Meaning |
| --- | --- | --- |
| `setup` | Optional shell command | [Install dependencies](sandbox.md#environments) |
| `toolchain` | Optional shell command | [Install build tools](sandbox.md#toolchains) |
| `image` | Local image, default `agentgraph-sandbox:local` | Image that runs commands |
| `network` | `egress` (default) or `models` | [Network for sessions](sandbox.md#the-network) |
| `stacks` | Boolean, default `false` | [Build one pull request on another](workflows.md#stacked-and-dependent-issues) |
| `milestone` | Optional milestone title | Restricts new runs to issues in the milestone. By default all open issues are in scope. |
| `commands` | Map to `true` (default), `false` or a list of logins | [Command authorization](workflows.md#commands) within the trust list |
| `status` | Map of statuses to names, or `false` | [Tracker status](workflows.md#status-on-the-issue), displayed as `agent:<status>` by default |
| `auth` | Plugin name, default `token` | [Studio auth](plugins.md#auth) for a graph on the host filesystem |
| `plugins` | Optional map | Settings supplied to [plugins](plugins.md) |
| `limits` | Map with the defaults below | Resource caps |

<!-- code: src/folder.ts#GraphSettings src/docker.ts#sandboxImage src/workflow.ts#CommandSettings src/workflow.ts#commandVerbs src/event.ts#issueStatuses src/tracker.ts#makeStatusLabel src/services.ts#pickAuth src/plugin.ts#readPlugins -->

The `limits` map controls resources for an instance. <!-- code: src/folder.ts#Limits -->

| Field | Default | Range or scope |
| --- | --- | --- |
| `memory` | `4g` | Docker memory size from `6m` to `64g` per command |
| `cpus` | 1.5 | From 0.01 to 64 CPUs per command |
| `minutes` | 30 | Positive time limit per session, script or setup command |
| `usd-per-run` | 10 | Positive spending limit per run |
| `max` | Each entry defaults to the corresponding graph limit | Maximum issue-label values for `minutes` and `usd-per-run` |
| `parallel` | 2 | Positive integer limiting concurrent scripts, check commands, setups and checkouts per instance |
| `sessions` | 2 | Positive integer limiting concurrent agent sessions, including judges, per instance |

<!-- code: src/folder.ts#Limits src/types.ts#CommandLimits src/docker.ts#limits src/run/execute.ts#slotsRef -->

Step `limits` override the specified `memory` and `cpus` fields. See [queue order](workflows.md#order-and-limits) and [remote runner restrictions](sandbox.md#runners). <!-- code: src/types.ts#CommandLimits src/remote.ts#whyBoxRefused src/run/execute.ts#runShell src/run/execute.ts#runSession src/run/check.ts#runStepChecks -->

## Workflows

`workflows/<name>.md` defines a workflow named after the file. Its body describes the workflow or prompts its single step. <!-- code: src/workflow.ts#Front src/workflow.ts#compileWorkflow -->

| Field | Accepted value and default |
| --- | --- |
| `on` | Required event name or map. The schema accepts `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback` and `conflict`. The map also accepts event keys for a live run. |
| `branch` | Template that expands `{issue}` and `{parent}`. Without it the run uses a detached checkout. |
| `base` | Base branch template. By default the run uses the instance base or the repository's default branch. |
| `concurrency` | `steer` (default), `queue` or `cancel`. See [comments while it works](workflows.md#comments-while-it-works). |
| `agent` | Agent for a workflow without `steps`. You can omit it if the graph has only one agent. |
| `steps` | Ordered map. The default is one agent step named after the workflow file. |
| `checks` | Optional list of [end checks](checks.md#end-checks) |

<!-- code: src/workflow.ts#Front src/workflow.ts#compileWorkflow src/settings.ts#getSettings -->

The schema accepts the following fields under `issues`, `issue_comment` and `pull_request`. Only `issues` uses the label and board settings. Under `issue_comment` the fields have no effect. The engine accepts `on.pull_request` but never uses it to select work. See [what starts a run](workflows.md#what-starts-a-run). <!-- code: src/workflow.ts#Trigger src/workflow.ts#Front src/workflow.ts#isIssueTriggered src/run/trigger.ts#tick -->

| Field | Meaning under `issues` |
| --- | --- |
| `label` | Name of the issue label |
| `column` | Name of a project board's Status option |
| `project` | Board identifier in `owner/number` form. It requires `column`. If omitted, matching columns on the repository owner's boards qualify. |
| `branches` | List of branch names. The engine accepts this field and ignores it. |

<!-- code: src/workflow.ts#Trigger src/workflow.ts#compileWorkflow src/workflow.ts#issueSources src/github.ts#githubTracker -->

The `dispatch` trigger takes no fields. See [dispatch](workflows.md#dispatch). <!-- code: src/workflow.ts#Front -->

The `feedback` trigger starts [retros](workflows.md#retros). Set `restarts: true` to include runs stopped by restart. It defaults to `false`. <!-- code: src/run/trigger.ts#feedback src/run/hear.ts#findSettledRuns src/workflow.ts#Front -->

For the other event keys in `on`, see [what a live run hears](workflows.md#what-a-live-run-hears). <!-- code: src/event.ts#HeardKinds src/workflow.ts#getHeard -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow -->

| Field | Accepted value and default | Meaning |
| --- | --- | --- |
| `agent` | Agent name | Runs a session with that agent. |
| `run` | Shell command | Executes a script. |
| `returns` | List of proposal kinds, default `[run]` | Names the [proposals](proposals.md#kinds) a `run:` step may return. |
| `wait` | `human` | Waits for a person. |
| `reads` | Optional `traces` | Allows a `run:` step to [read traces](checks.md#reading-traces). |
| `carry` | Boolean, default `false` | Passes the successful reply to the next step. |
| `skill` | Optional skill name | Supplies instructions. By default the engine uses a skill with the same name as the step, if one exists. |
| `checks` | Optional list of check names | Checks each try. At a human wait they check base updates and default to the script checks on the `back` target. |
| `limits` | Optional map of `memory` and `cpus` | Overrides the graph's resources for the step and its checks. |
| `tries` | Positive integer | Counts the first attempt. It defaults to 3 for a step with checks and 1 otherwise. A human wait defaults to 1. |
| `back` | Optional step name | Returns to this step or an earlier one. |
| `until` | Sentence | States the goal for an agent step with `back`. |
| `rounds` | Positive integer | Limits returns to the `back` target. The default is 3, or unlimited at a human wait. |
| `each` | Optional `files`, `hunks` or shell command | Processes items in order using the agent's [session policy](#sessions). Above 20 items, one turn handles them all. |
| `follow` | `merge` (default), `rebase` or `none` | Selects how a human wait [follows the base](workflows.md#when-the-base-or-the-graph-moves). |
| `conflict` | `back`, `ask` or a workflow name | Handles conflicts at a human wait. By default the engine chooses a conflict workflow, then a configured way back, then a question. |

<!-- code: src/workflow.ts#StepFile src/workflow.ts#compileWorkflow src/run/checkout.ts#most src/run/attempt.ts#runAttempt -->

## Agents

Write each agent in `agents/<name>.md`. Its body becomes part of the harness’s system prompt. <!-- code: src/types.ts#Agent src/run/attempt.ts#runAttempt -->

| Field | Accepted value and default |
| --- | --- |
| `harness` | [Harness name](sandbox.md#harnesses). By default the provider's first harness runs, or the config's first harness if no provider selects one. |
| `model` | Model alias. The default is `default`, or Claude Code's own model selection. |
| `tools` | Optional list of built-in or [plugin tools](plugins.md) |
| `returns` | List of [proposal kinds](proposals.md#kinds), default `[comment]` |
| `reads` | Optional `traces`. The agent needs a tool that can read files. |
| `session` | Optional `fresh` or `same`. See [sessions](#sessions). |

<!-- code: src/types.ts#Agent src/folder.ts#compile src/harnesses.ts#readHarnessSettings -->

Setting `AGENTGRAPH_HARNESS` overrides every agent’s own `harness`. If the variable is unset, the config’s `harness` also overrides every agent. See [harness selection](sandbox.md#harnesses). <!-- code: src/harnesses.ts#readHarnessSettings src/folder.ts#loadGraph src/folder.ts#compile -->

## Sessions

Without `session`, a step reuses its session across tries, `back`, answers and asides. Forward re-entry starts a new session. Steps with `each` and judges start fresh per item. <!-- code: src/run/attempt.ts#runAttempt src/run/check.ts#runOneCheck src/workflow.ts#transition -->

`session: same` keeps one session per run for each step or check. A step keeps it on forward re-entry. If the step has `back` and does not use `each`, the resumed session receives the branch diff again. Steps with `each` process items as sequential turns. Judges reuse one session per check across items, tries and rounds. On later tries, they are told the change may have moved. <!-- code: src/run/attempt.ts#runAttempt src/run/check.ts#runOneCheck src/workflow.ts#transition -->

`session: fresh` starts a new session each time. [Judges missing results](checks.md#judges) still resume once. <!-- code: src/run/attempt.ts#runAttempt src/run/execute.ts#runJudge -->

If resuming fails before the harness starts, or another harness ran the session, the engine retries once fresh with the full prompt. <!-- code: src/run/attempt.ts#runAttempt src/run/check.ts#runOneCheck src/workflow.ts#transition -->

## Checks

Define each check in `checks/<name>.md` with `run`, `agent` or both. The body describes the check. See [Checks and results](checks.md). <!-- code: src/types.ts#Check src/result.ts#CheckMode src/run/checkout.ts#findFanOutItems src/run/checkout.ts#most -->

| Field | Accepted value and default |
| --- | --- |
| `mode` | Required [failure policy](checks.md) of `info`, `warn`, `block` or `stop` |
| `run` | Shell command. For a script check without custom `returns`, exit 0 passes. |
| `agent` | Name of the judge that records a result with the `result` tool |
| `each` | Optional `files`, `hunks`, `merged` or shell command. With `merged` the items are hunks gained from the base. |
| `max` | Positive integer. It defaults to the [step fan-out cap](#steps). Exceeding it produces a finding. |
| `returns` | Result schema, defaulting to fields `pass` and `why` |
| `pass` | Schema that a result must match to pass. By default it requires `pass` to equal `true`. Mode `info` forbids this field. |
| `reads` | Optional `traces`. A trace check can [evaluate ended runs](checks.md#end-checks). |

<!-- code: src/types.ts#Check src/result.ts#CheckMode src/run/checkout.ts#findFanOutItems src/run/check.ts#runOneCheck -->

The schema supports `type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum` and `description`. Numeric fields may set a display `unit`: `usd`, `minutes`, `seconds`, `tokens` or `share`. <!-- code: src/result.ts#ResultType -->

The roots of `returns` and `pass` allow only `type: object`, `properties` and `required`. A field with `type` accepts only keywords for that type: objects use `properties` and `required`, arrays use `items`, and numbers and integers use `minimum` and `maximum`. Without `type`, each keyword applies only to values it fits. `enum` and `const` compare content, ignoring key order. <!-- code: src/types.ts#ResultRoot src/result.ts#findMismatch -->

## Skills

Write a skill in `skills/<name>.md` or `skills/<name>/SKILL.md`. The body gives the agent its instructions. The engine ignores frontmatter keys outside the table. <!-- code: src/folder.ts#SkillFile src/folder.ts#markdown src/folder.ts#compile -->

| Field | Accepted value | Meaning |
| --- | --- | --- |
| `description` | Optional text | Describes the skill |
| `uses` | Optional list of skill names | Appends their instructions in the listed order |

<!-- code: src/folder.ts#SkillFile src/run/attempt.ts#runAttempt -->
