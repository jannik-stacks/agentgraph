# Hub files

Every field a hub file may hold, with its type, its default and what it does. An unknown field is an error, and a removed one is reported with what to write instead. <!-- code: src/hub.ts#gone -->

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

`limits` holds three fields: <!-- code: src/hub.ts#Limits -->

| Field         | Type    | Default | Meaning                                          |
| ------------- | ------- | ------- | ------------------------------------------------ |
| `minutes`     | number  | 30      | The longest one session, script or setup may run |
| `usd-per-run` | number  | 10      | The most a run may spend                         |
| `parallel`    | integer | 2       | How many runs go at once                         |

## Workflows

`workflows/<name>.md`. The file name is the workflow's name. The body is its description, or the prompt when it has no steps. <!-- code: src/workflow.ts#Front -->

| Field    | Type                           | Default                             | Meaning                                                           |
| -------- | ------------------------------ | ----------------------------------- | ----------------------------------------------------------------- |
| `on`     | event name, or map of triggers | required                            | What starts a run: `issues`, `issue_comment` or `pull_request`    |
| `branch` | template                       | none, a detached checkout           | The branch a run works on; `{issue}` and `{parent}` are filled in |
| `base`   | template                       | `main`                              | The branch its pull requests go into                              |
| `agent`  | agent name                     | the hub's only agent                | The agent of a workflow without `steps`                           |
| `steps`  | map of step name to step       | one agent step named after the file | The steps, run in the order written                               |

A trigger under `on` holds: <!-- code: src/workflow.ts#Trigger -->

| Field      | Type          | Meaning                                 |
| ---------- | ------------- | --------------------------------------- |
| `command`  | text          | A comment starting with it starts a run |
| `label`    | label name    | Adding it to an issue starts a run      |
| `branches` | list of names | Accepted, starts nothing yet            |

## Steps

A step names exactly one of `agent`, `run` and `wait`. <!-- code: src/workflow.ts#StepFile -->

| Field    | Type                                     | Default                               | Meaning                                            |
| -------- | ---------------------------------------- | ------------------------------------- | -------------------------------------------------- |
| `agent`  | agent name                               | none                                  | An agent runs the step in a session                |
| `run`    | shell command                            | none                                  | A script runs the step                             |
| `wait`   | `human`                                  | none                                  | The step waits for a person                        |
| `skill`  | skill name                               | the skill named like the step, if any | The skill handed to the agent                      |
| `checks` | list of check names                      | none                                  | What must pass before the step is done             |
| `tries`  | positive integer                         | 3 with checks, else 1                 | Tries before the run waits, the first one included |
| `back`   | step name                                | none                                  | This step or an earlier one the run may go back to |
| `until`  | sentence                                 | required on an agent step with `back` | When the step is satisfied                         |
| `rounds` | positive integer                         | 3, no cap on a `wait` step            | How many times the step may go back                |
| `each`   | `files`, `hunks` or `{ run: <command> }` | none                                  | One fresh session per item                         |

## Agents

`agents/<name>.md`. The body is added to the harness's system prompt. <!-- code: src/hub.ts#Agent -->

| Field     | Type                         | Default                                 | Meaning                                                 |
| --------- | ---------------------------- | --------------------------------------- | ------------------------------------------------------- |
| `harness` | `claude`, `opencode` or `pi` | required                                | The program that runs the session                       |
| `model`   | model alias                  | `default`, or Claude Code's own default | The alias the model proxy maps to a model               |
| `tools`   | list of tool names           | none                                    | The tools a session may use                             |
| `returns` | list of proposal kinds       | `[comment]`                             | The kinds it may propose, see [Proposals](proposals.md) |

## Checks

`checks/<name>.md`. A check names `run`, `agent` or both. The body is its description. <!-- code: src/hub.ts#Check -->

| Field   | Type                          | Default  | Meaning                                               |
| ------- | ----------------------------- | -------- | ----------------------------------------------------- |
| `mode`  | `warn`, `block` or `stop`     | required | What a failure does, see [The loop](loop.md#checks)   |
| `run`   | shell command                 | none     | A script; exit 0 passes                               |
| `agent` | agent name                    | none     | An agent judges; a reply starting with `PASS` passes  |
| `each`  | `files`, `hunks` or a command | none     | Judges each item on its own                           |
| `max`   | positive integer              | no cap   | The most items `each` may find before the check fails |

## Skills

`skills/<name>.md` or `skills/<name>/SKILL.md`. The body is the instruction. <!-- code: src/hub.ts#SkillFile -->

| Field         | Type                | Default | Meaning                                           |
| ------------- | ------------------- | ------- | ------------------------------------------------- |
| `description` | text                | none    | What the skill is for                             |
| `uses`        | list of skill names | none    | Skills whose bodies follow this one in the prompt |
