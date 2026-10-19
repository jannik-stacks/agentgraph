# Hub files

Every field a hub file may hold, with its type, its default and what it does. An unknown field is an error, and a removed one is reported with what to write instead. <!-- code: src/hub.ts#gone -->

A hub is a folder: `.bothub/` on the default branch of the repo it works on, or a folder on this machine given with `--hub`, see [A hub in the repo](loop.md#a-hub-in-the-repo). Its version is a hash of `hub.yaml` and every agent, skill, check, workflow and script in it. When the version changes, runs waiting for a human are checked again, see [When the base or the hub moves](loop.md#when-the-base-or-the-hub-moves). <!-- code: src/hub.ts#loadHub -->

## hub.yaml

<!-- code: src/hub.ts#HubFile -->

| Field       | Type                 | Default                           | Meaning                                                              |
| ----------- | -------------------- | --------------------------------- | -------------------------------------------------------------------- |
| `repo`      | `owner/name`         | none                              | The GitHub repo the hub works on                                     |
| `setup`     | shell script         | none                              | Runs once in each new checkout, with network, before the first step  |
| `image`     | local image name     | `bothub-sandbox:local`            | The image every command of a run starts in                           |
| `network`   | `egress` or `models` | `egress`                          | What sessions and setup reach, see [Sandbox](sandbox.md#the-network) |
| `stacks`    | boolean              | `false`                           | Whether a `Stacks on #n` line builds on the pull request of #n       |
| `milestone` | milestone title      | none, every open issue            | Only open issues in this milestone start runs                        |
| `trust`     | list of logins       | owners, members and collaborators | Who may steer the bot, see [The loop](loop.md#trust-and-scope)       |
| `limits`    | map                  | the defaults below                | Caps on a run                                                        |

`limits` in `hub.yaml` sets these: <!-- code: src/hub.ts#Limits -->

| Field         | Type    | Default | Meaning                                                                                                  |
| ------------- | ------- | ------- | -------------------------------------------------------------------------------------------------------- |
| `minutes`     | number  | 30      | The wall-clock deadline for one session, script or setup, however much it prints                         |
| `usd-per-run` | number  | 10      | The most a run may spend                                                                                 |
| `parallel`    | integer | 2       | How many runs go at once                                                                                 |
| `sessions`    | integer | 4       | How many sessions, judges included, are live at once across all runs <!-- code: src/engine.ts#gateOf --> |

## Workflows

`workflows/<name>.md`. The file name is the workflow's name. The body is its description, or the prompt when it has no steps. <!-- code: src/workflow.ts#Front -->

| Field         | Type                           | Default                             | Meaning                                                                    |
| ------------- | ------------------------------ | ----------------------------------- | -------------------------------------------------------------------------- |
| `on`          | event name, or map of triggers | required                            | What starts a run: `issues`, `issue_comment`, `pull_request`, `dispatch` or `feedback` |
| `branch`      | template                       | none, a detached checkout           | The branch a run works on; `{issue}` and `{parent}` are filled in          |
| `base`        | template                       | `main`                              | The branch its pull requests go into                                       |
| `concurrency` | `steer`, `queue` or `cancel`   | `steer`                             | What a trusted comment does to a working run                               |
| `agent`       | agent name                     | the hub's only agent                | The agent of a workflow without `steps`                                    |
| `steps`       | map of step name to step       | one agent step named after the file | The steps, run in the order written                                        |

`concurrency` decides what a trusted comment on a working run does. It never starts a second run on the issue. <!-- code: src/workflow.ts#Front -->

- `steer`: the session reads it in its news file and gets one more turn with it before the checks.
- `queue`: it waits until the try ends, then applies as an answer would.
- `cancel`: the session stops and the step starts again at once with it as feedback.

Comments that come in a burst count once, and the loop waits until an issue has been quiet for 30 seconds before they start or wake a run. A reply of `cancel` or `stop` works at any time. See [Comments while it works](loop.md#comments-while-it-works).

A trigger under `on` holds: <!-- code: src/workflow.ts#Trigger -->

| Field      | Type          | Meaning                                 |
| ---------- | ------------- | --------------------------------------- |
| `command`  | text          | A comment starting with it starts a run; with `restart [step]` after it, starts one again, see [Starting a run](loop.md#starting-a-run) |
| `label`    | label name    | Adding it to an issue starts a run      |
| `branches` | list of names | Accepted, starts nothing yet            |

`dispatch` takes no fields: `on: dispatch`, or `dispatch` beside other triggers as in `on: { issues: { label: triage }, dispatch }`. Such a workflow also starts from a `run` proposal, see [Dispatch](loop.md#dispatch).

`feedback` takes no fields either: `on: feedback` starts a retro on what a trusted person says or pushes where another run worked, see [Compound engineering](compound.md). <!-- code: src/engine.ts#feedback -->

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile -->

| Field    | Type                                     | Default                               | Meaning                                            |
| -------- | ---------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `agent`  | agent name                               | none                                  | An agent runs the step in a session                |
| `run`    | shell command                            | none                                  | A script runs the step                             |
| `wait`   | `human`                                  | none                                  | The step waits for a person, see [Asides](loop.md#asides) |
| `skill`  | skill name                               | the skill named like the step, if any | The skill handed to the agent                      |
| `checks` | list of check names                      | none; on a `wait` step, the script checks of its `back` step | What must pass before the step is done; on a `wait` step, what runs again when the base moves |
| `tries`  | positive integer                         | 3 with checks, else 1                 | Tries before the run waits, the first one included |
| `back`   | step name                                | none                                  | This step or an earlier one the run may go back to |
| `until`  | sentence                                 | required on an agent step with `back` | When the step is satisfied                         |
| `rounds` | positive integer                         | 3, no cap on a `wait` step            | How many times the step may go back                |
| `each`   | `files`, `hunks` or `{ run: <command> }` | none                                  | One fresh session per item; past 20 items, one session over them all |
| `follow` | `merge` or `rebase`                      | `merge`, on a `wait` step only        | How the branch follows a moved base, see [When the base or the hub moves](loop.md#when-the-base-or-the-hub-moves) |

## Agents

`agents/<name>.md`. The body is added to the harness's system prompt. <!-- code: src/hub.ts#Agent -->

| Field     | Type                         | Default                                 | Meaning                                                 |
| --------- | ---------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `harness` | `claude`, `opencode` or `pi` | required                                | The program that runs the session                       |
| `model`   | model alias                  | `default`, or Claude Code's own default | The alias the model proxy maps to a model               |
| `tools`   | list of tool names           | none                                    | The tools a session may use                             |
| `returns` | list of proposal kinds       | `[comment]`                             | The kinds it may propose, see [Proposals](proposals.md) |
| `reads`   | `traces`                     | none                                    | Its sessions get the traces of the runs on the issue; needs `read` in `tools`, see [Reading traces](compound.md#reading-traces) |

## Checks

`checks/<name>.md`. A check names `run`, `agent` or both. The body is its description. <!-- code: src/hub.ts#Check -->

| Field   | Type                          | Default  | Meaning                                                                 |
| ------- | ----------------------------- | -------- | ----------------------------------------------------------------------- |
| `mode`  | `warn`, `block` or `stop`     | required | What a failure does, see [The loop](loop.md#checks)                     |
| `run`   | shell command                 | none     | A script; exit 0 passes                                                 |
| `agent` | agent name                    | none     | An agent judges; a reply starting with `PASS` passes, with `FAIL` fails |
| `each`  | `files`, `hunks` or a command | none     | Judges each item on its own                                             |
| `max`   | positive integer              | 20       | The most items `each` may find before the check fails                   |

## Skills

`skills/<name>.md` or `skills/<name>/SKILL.md`. The body is the instruction. <!-- code: src/hub.ts#SkillFile -->

| Field         | Type                | Default | Meaning                                           |
| ------------- | ------------------- | ------- | ------------------------------------------------- |
| `description` | text                | none    | What the skill is for                             |
| `uses`        | list of skill names | none    | Skills whose bodies follow this one in the prompt |

## instance.yaml

An [instance](local.md#instances) is a folder with `instance.yaml`, the hub in `hub/`, a forge folder in `forge/`, the data dir in `data/` and an optional `keys.env`. `node bin/forge.ts <dir> init <repo> --hub <hub>` writes it. <!-- code: src/instance.ts#Instance -->

| Field   | Type                     | Default                | Meaning                                                         |
| ------- | ------------------------ | ---------------------- | --------------------------------------------------------------- |
| `repo`  | path                     | none                   | The git repo on this machine the instance copies and exports to |
| `base`  | branch name              | `main`                 | The branch `sync` and `export --patch` read from the repo       |
| `owner` | name                     | `git config user.name` | Who `bin/forge.ts` acts as when `--as` is not given             |
| `logs`  | `all`, `failed` or `off` | `all`                  | Which check output the data dir keeps, as `BOTHUB_CHECK_LOGS`   |
