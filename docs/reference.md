# Hub files

Every hub field with its type and default. `check` fails on an unknown key, a missing agent, check or skill, a duplicate name, an agent, check or skill nothing uses, an end check that is not `warn`, an unknown proposal kind in a body, and retired words. Besides these files a hub may hold `scripts/` and `fixtures/`; other folders must be read through `$AGENTGRAPH_HUB`. <!-- code: src/hub.ts#loadHub -->

## hub.yaml

<!-- code: src/hub.ts#HubFile -->

| Field       | Type                 | Default                           | Meaning                                                              |
| ----------- | -------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `repo`      | `owner/name`         | none                              | GitHub repo                                                          |
| `setup`     | shell script         | none                              | Dependency setup; see [Environments](sandbox.md#environments)        |
| `toolchain` | shell script         | none                              | Extra tool installs; see [Toolchains](sandbox.md#toolchains)         |
| `image`     | local image name     | `agentgraph-sandbox:local`        | Base image for run commands                                          |
| `network`   | `egress` or `models` | `egress`                          | What sessions and setup reach, see [Sandbox](sandbox.md#the-network) |
| `stacks`    | boolean              | `false`                           | Enable [stacked pull requests](stacks.md#stacks-on-and-depends-on)   |
| `milestone` | milestone title      | none, every open issue            | Scope for new runs                                                   |
| `trust`     | list of logins       | owners, members and collaborators | Who may steer the bot, see [The loop](loop.md#trust-and-scope)       |
| `limits`    | map                  | the defaults below                | Caps on a run                                                        |

`limits` in `hub.yaml` sets these: <!-- code: src/hub.ts#Limits -->

| Field         | Type    | Default | Meaning                                                                               |
| ------------- | ------- | ------- | ------------------------------------------------------------------------------------- |
| `minutes`     | number  | 30      | Wall-clock deadline per session, script or setup                                      |
| `usd-per-run` | number  | 10      | Run spend cap                                                                         |
| `parallel`    | integer | 2       | Concurrent runs                                                                       |
| `sessions`    | integer | 4       | Concurrent sessions across runs, including judges <!-- code: src/engine.ts#getSessionGate --> |

## Workflows

`workflows/<name>.md`. File name names the workflow; body describes it or prompts its single step. <!-- code: src/workflow.ts#Front -->

| Field         | Type                           | Default                             | Meaning                                                                                |
| ------------- | ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------------------- |
| `on`          | event name, or map of triggers | required                            | What starts a run: `issues`, `issue_comment`, `pull_request`, `dispatch` or `feedback` |
| `branch`      | template                       | none, a detached checkout           | Work branch; expands `{issue}` and `{parent}`                                          |
| `base`        | template                       | `main`                              | Pull request base                                                                      |
| `concurrency` | `steer`, `queue` or `cancel`   | `steer`                             | Comment handling while working                                                         |
| `agent`       | agent name                     | the hub's only agent                | Agent without `steps`                                                                  |
| `steps`       | map of step name to step       | one agent step named after the file | Steps in written order                                                                 |
| `checks`      | list of check names            | none                                | `warn` checks run once when the run ends, see [The loop](loop.md#at-run-end-and-later) |

See [Comments while it works](loop.md#comments-while-it-works) for concurrency, bursts and cancellation.

A trigger under `on` holds: <!-- code: src/workflow.ts#Trigger -->

| Field      | Type          | Meaning                            |
| ---------- | ------------- | ---------------------------------- |
| `label`    | label name    | Adding it to an issue starts a run |
| `branches` | list of names | Accepted, starts nothing yet       |

`dispatch` and `feedback` take no fields: use `on: dispatch` or a map such as `on: { issues: { label: triage }, dispatch }`. See [Dispatch](loop.md#dispatch) and [retros](compound.md#the-retro). <!-- code: src/engine.ts#feedback -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile -->

| Field    | Type                                     | Default                                                      | Meaning                                                                                                                     |
| -------- | ---------------------------------------- | ------------------------------------------------------------ | --------------------------------------------------------------------------------------------------------------------------- |
| `agent`  | agent name                               | none                                                         | An agent runs the step in a session                                                                                         |
| `run`    | shell command                            | none                                                         | A script runs the step                                                                                                      |
| `wait`   | `human`                                  | none                                                         | The step waits for a person, see [Asides](loop.md#asides)                                                                   |
| `skill`  | skill name                               | the skill named like the step, if any                        | Agent instruction                                                                                                           |
| `checks` | list of check names                      | none; on a `wait` step, the script checks of its `back` step | Required checks; at `wait`, base-update checks                                                                              |
| `tries`  | positive integer                         | 1 at `wait`; otherwise 3 with checks, else 1                 | Attempts including first, then wait                                                                                         |
| `back`   | step name                                | none                                                         | This step or an earlier one the run may go back to                                                                          |
| `until`  | sentence                                 | required on an agent step with `back`                        | When the step is satisfied                                                                                                  |
| `rounds` | positive integer                         | 3, no cap on a `wait` step                                   | Return cap                                                                                                                  |
| `each`   | `files`, `hunks` or `{ run: <command> }` | none                                                         | One fresh session per item; past 20 items, one session over them all                                                        |
| `follow` | `merge`, `rebase` or `none` | `merge`, on a `wait` step only | How the branch follows a moved base, see [base updates](loop.md#when-the-base-or-the-hub-moves) |

## Agents

`agents/<name>.md`. The body is added to the harness's system prompt. <!-- code: src/hub.ts#Agent -->

| Field     | Type                         | Default                                 | Meaning                                                                                          |
| --------- | ---------------------------- | --------------------------------------- | ------------------------------------------------------------------------------------------------ |
| `harness` | a harness name from the config | the provider's first, else the config's first | The program that runs the session; see [Harnesses](sandbox.md#harnesses)                 |
| `model`   | model alias                  | `default`, or Claude Code's own default | Proxy model alias                                                                                |
| `tools`   | list of tool names           | none                                    | Allowed tools                                                                                    |
| `returns` | list of proposal kinds       | `[comment]`                             | The kinds it may propose, see [Proposals](proposals.md)                                          |
| `reads`   | `traces`                     | none                                    | Include issue run traces; requires `read` tool. See [Reading traces](compound.md#reading-traces) |

## Checks

`checks/<name>.md`. A check has `run`, `agent` or both. The body is its description. <!-- code: src/hub.ts#Check -->

| Field     | Type                                 | Default          | Meaning                                                                           |
| --------- | ------------------------------------ | ---------------- | --------------------------------------------------------------------------------- |
| `mode`    | `info`, `warn`, `block` or `stop`    | required         | What a failure does, see [The loop](loop.md#checks)                               |
| `run`     | shell command                        | none             | A script; without its own `returns`, exit 0 passes                               |
| `agent`   | agent name                           | none             | Judge; records its result with the `result` tool                                  |
| `each`    | `files`, `hunks` or a command        | none             | Judges each item on its own                                                       |
| `max`     | positive integer                     | 20               | Fan-out item cap; exceeding fails                                                 |
| `returns` | JSON Schema subset                   | `{pass, why}`    | The result's shape, see [Values](loop.md#values)                                  |
| `pass`    | JSON Schema subset                   | `pass` is true   | The results that pass; not on `info`                                              |
| `reads`   | `traces`                             | none             | Needs only the run's traces, so it runs on old runs without their kept files      |

The schema subset has `type`, `properties`, `required`, `items`, `enum`, `const`, `minimum`, `maximum` and `description`.

## Skills

`skills/<name>.md` or `skills/<name>/SKILL.md` (Agent Skills format). The body is the instruction. Other frontmatter keys are ignored. <!-- code: src/hub.ts#SkillFile -->

| Field         | Type                | Default | Meaning                                           |
| ------------- | ------------------- | ------- | ------------------------------------------------- |
| `description` | text                | none    | What the skill is for                             |
| `uses`        | list of skill names | none    | Skills whose bodies follow this one in the prompt |

## instance.yaml

Written by the first command in a repo; see [the data dir](forge.md#the-data-dir). <!-- code: src/instance.ts#Instance -->

| Field      | Type                  | Default                       | Meaning                                                   |
| ---------- | --------------------- | ----------------------------- | --------------------------------------------------------- |
| `repo`     | path                  | the repo                      | The checkout the forge's base syncs from and branches go to |
| `base`     | branch name           | the branch checked out first  | The branch the forge's base fast-forwards to              |
| `owner`    | name                  | `git config user.name`        | The author of every local verb and the only trusted login |
| `provider` | provider name         | none                          | The saved provider: the only ready one, the one picked when several were, or `--provider` with `--save` |
| `exported` | map of ref to commit  | none                          | Where agentgraph last wrote each ref into the repo        |
