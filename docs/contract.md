# The hub contract

From 0.2.0 on the engine changes rarely, and the work of making bothub better on a repo happens in its hub. This page lists what a hub and the people running it can rely on. Every name here keeps its name and meaning across 0.x releases. A release that renames or drops one says so in `CHANGELOG.md`, and `check` reports the old key with what to write instead. <!-- code: src/hub.ts#gone -->

## Engine

The engine is the code that turns events into runs:

- `src/`, the engine itself. A tune pins it by the git tree of `src/`.
- `bin/run.ts`, `bin/forge.ts` and `bin/setup-app.ts`, the commands below.
- The sandbox image and the model proxy setup in `infra/`.

The bench, the tune loop and the studio (`bin/bench.ts`, `bin/tune.ts`, `bench/`, `tune/`, `studio/`) read the engine and its data dir. They change on their own schedule and never change what a run does.

## Hub

Everything in a hub folder is tunable. The fields are described in [Hub files](reference.md).

| File                    | Stable fields                                                                                    |
| ----------------------- | ------------------------------------------------------------------------------------------------ |
| `hub.yaml`              | `repo`, `setup`, `toolchain`, `image`, `network`, `stacks`, `milestone`, `trust`, `limits`        |
| `limits` in `hub.yaml`  | `minutes`, `usd-per-run`, `parallel`, `sessions`                                                 |
| `workflows/<name>.md`   | `on`, `branch`, `base`, `concurrency`, `agent`, `steps`                                          |
| a trigger under `on`    | `issues`, `issue_comment`, `pull_request`, `dispatch`, `feedback`; `command`, `label`, `branches` |
| a step                  | `agent`, `run`, `wait`, `skill`, `checks`, `tries`, `back`, `until`, `rounds`, `each`, `follow`  |
| `agents/<name>.md`      | `harness`, `model`, `tools`, `returns`, `reads`                                                  |
| `checks/<name>.md`      | `mode`, `run`, `agent`, `each`, `max`                                                            |
| `skills/<name>.md`      | `description`, `uses`                                                                            |

The Markdown bodies are prompts and descriptions, free to change. Scripts and other folders are the hub's own, read through `$BOTHUB_HUB`. The proposal kinds an agent may return are in [Proposals](proposals.md#kinds).

A hub script gets `BOTHUB_HUB` and `BOTHUB_BASE`. A check script also gets `BOTHUB_ISSUE`, `BOTHUB_ITEM` when it judges one item, and the files `BOTHUB_PROPOSALS`, `BOTHUB_CONTEXT`, `BOTHUB_REPLY` and `BOTHUB_TRACES`. <!-- code: src/engine.ts#checkFiles -->

## Commands

| Command                                                   | What it does                                          |
| --------------------------------------------------------- | ----------------------------------------------------- |
| `node bin/run.ts check --hub <dir>`                       | Loads a hub and prints every problem, or `ok`         |
| `node bin/run.ts --hub <dir> --issue <n> --data <dir>`    | Looks at one issue once; `--all` for every open issue |
| `node bin/run.ts loop --hub <dir> --data <dir>`           | Sweeps once, then looks every `BOTHUB_EVERY` minutes  |
| `node bin/run.ts status --hub <dir> --data <dir>`         | Lists what waits on a human                           |
| `node bin/run.ts prune-logs --data <dir> --apply`         | Deletes check logs no trace names                     |
| `node bin/forge.ts <dir> init <git repo> --hub <hub>`     | Makes a local instance, see [Instances](local.md#instances) |
| `node bin/setup-app.ts`                                   | Creates the GitHub App                                |

`--forge`, `--instance` and `--logs` work with every `bin/run.ts` command that runs or reads issues. The variables the runner reads are listed in [Running it locally](local.md).

## Tuning inside it

A tune changes hub files only. `tune init` records the engine as the release tag the checkout sits on, such as `bothub-v0.2.0`, or as the commit when there is none. Every run of the tune refuses an engine whose `src/` tree differs.

When a hub needs something this page does not offer, that is an engine change: it goes through the bench on a fixed hub, ships in a new release, and tunes start again from it.
