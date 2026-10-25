# The hub contract

Nothing here is stable yet: names and abstractions change whenever we find better ones, hub calls such as `say`, `tell` and `dispatch` included. Every rename or removal is listed in `CHANGELOG.md`, and `check` fails on a key the hub no longer has. <!-- code: src/hub.ts#loadHub -->

## Engine

The engine is `src/`, `bin/run.ts`, `bin/forge.ts`, `bin/setup-app.ts` and the sandbox and proxy setup in `infra/`. Bench, tune and studio code read the engine and its data, and change on their own schedule.

## Hub

Every [hub field](reference.md) is listed in the reference, and the [proposal kinds](proposals.md#kinds) are the agents' write contract.

Prompts, descriptions, scripts and extra folders are free to change. Scripts reach the hub through `$AGENTGRAPH_HUB` and get the [script variables](loop.md#checks). <!-- code: src/engine.ts#checkFiles -->

## Commands

These are the entry points:

- `npx agentgraph` with `check` (and `check --runs`), `start`, `--issue`, `--all`, `loop`, `status` and `prune-logs`, and the flags `--forge`, `--instance` and `--logs`; see [the CLI](local.md#the-cli).
- `node bin/forge.ts <dir> init <repo> --hub <hub>`; see [Instances](forge.md#instances).
- `node bin/setup-app.ts`; see [App setup](../infra/github/README.md).

## Tuning inside it

A tune changes hub files only. It records the engine release it starts from, such as `agentgraph-v0.2.0`, or else a commit, and its runs refuse an engine whose `src/` tree differs.

Anything beyond this contract needs an engine change, a bench run on a fixed hub and a new release. Tunes then start again from that release.
