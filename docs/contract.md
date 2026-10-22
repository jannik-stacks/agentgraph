# The hub contract

The 0.2.0 contract preserves names and meanings across 0.x releases. Renames and removals must appear in `CHANGELOG.md`; `check` reports retired keys with replacements. <!-- code: src/hub.ts#gone -->

## Engine

The engine comprises `src/`, `bin/run.ts`, `bin/forge.ts`, `bin/setup-app.ts` and sandbox/proxy infrastructure. Tunes pin the `src/` git tree. Bench, tune and studio tooling read the engine and data; they evolve separately.

## Hub

All [hub fields](reference.md) are stable: hub settings and limits, workflows and triggers, steps, agents, checks and skills. [Proposal kinds](proposals.md#kinds) form the agent write contract.

Markdown prompts, descriptions, scripts and extra folders are tunable. Scripts access the hub through `$AGENTGRAPH_HUB`. The [script environment](loop.md#checks) defines step and check inputs. <!-- code: src/engine.ts#checkFiles -->

## Commands

Stable entry points:

- `node bin/run.ts check`, issue execution, `loop`, `status` and `prune-logs`; see [CLI](local.md#the-cli) and [log pruning](runs.md#check-logs).
- `node bin/forge.ts <dir> init <repo> --hub <hub>`; see [Instances](local.md#instances).
- `node bin/setup-app.ts`; see [App setup](../infra/github/README.md).

Issue commands also accept `--forge`, `--instance` and `--logs`. [Runner settings](local.md#the-cli) document environment variables.

## Tuning inside it

Tunes change hub files only. Initialization records the engine release tag, such as `agentgraph-v0.2.0`, otherwise its commit. Runs reject a different `src/` tree.

Features beyond this contract require an engine change, a bench run on a fixed hub and a new release. Tunes restart from that release.
