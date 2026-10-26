# The graph contract

Nothing here is stable yet: names and abstractions change whenever we find better ones, CLI verbs such as `say` and `dispatch` included. Every rename or removal is listed in `CHANGELOG.md`, and `check` fails on any key it does not know. <!-- code: src/folder.ts#loadGraph -->

## Engine

The engine is `src/`, `bin/run.ts`, `bin/setup-app.ts`, the packaged `default/` folder and the sandbox and proxy setup in `infra/`. Bench, tune and studio code read the engine and its data, and change on their own schedule.

## Graph

Every [graph field](reference.md) is listed in the reference, and the [proposal kinds](proposals.md#kinds) are the agents' write contract.

Prompts, descriptions, scripts and extra folders are free to change. Scripts reach the graph through `$AGENTGRAPH_DIR` and get the [script variables](loop.md#checks). <!-- code: src/engine.ts#checkFiles -->

## Commands

These are the entry points:

- `npx agentgraph` with `start`, `say`, `review`, `merge`, `export`, `close`, `show`, `loop`, `check`, `dispatch` and `prune-logs`, and the flags `--data`, `--repo`, `--base`, `--dir`, `--forge` and `--logs`; see [Verbs](forge.md#verbs) and [the CLI](local.md#the-cli).
- `node bin/setup-app.ts`; see [App setup](../infra/github/README.md).

## Tuning inside it

A tune changes graph files only. It records the engine release it starts from, such as `agentgraph-v0.2.0`, or else a commit, and its runs refuse an engine whose `src/` tree differs.

Anything beyond this contract needs an engine change, a bench run on a fixed graph and a new release. Tunes then start again from that release.
