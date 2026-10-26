# Engine and code

The engine is the runner code in `src/`. [STYLE.md](../STYLE.md) has the code rules.

## Where everything lives

```
 GitHub: issues, comments, pull requests
      ^                          │
      │ writes, with the App     │ events, read through the App
      │                          v
┌─────────────────────────────────────────────────────────────────┐
│ host                                                            │
│  runner process = the engine                                    │
│    looks at the repo, begins and drives runs                    │
│    pushes and opens pull requests through the Git API           │
│         │                                 │                     │
│         │ docker run --rm                 │ reads and writes    │
│         v                                 v                     │
│  ┌──────────────────────────┐  ┌─────────────────────────────┐  │
│  │ sandbox                  │  │ data folder                 │  │
│  │ one session              │  │ <run id>/run.json           │  │
│  │ /work: git worktree      │  │ <run id>/trace.jsonl        │  │
│  │ no GitHub token          │  │ mirror.git, work/, homes/   │  │
│  └────────────┬─────────────┘  └──────────────┬──────────────┘  │
│               │ model calls                   │                 │
│               v                               v                 │
│  ┌──────────────────────────┐  studio reads the graph,          │
│  │ model gateway            │  run.json and trace               │
│  └────────────┬─────────────┘                                   │
└───────────────┼─────────────────────────────────────────────────┘
                v
         model providers
```

<!-- code: src/main.ts#start -->

The engine reaches the outside only through four services, each with a test stand-in:

- The forge reads and writes GitHub, or a folder. <!-- code: src/forge.ts#Forge -->
- The store keeps runs and traces. <!-- code: src/store.ts#Store -->
- The sandbox runs commands in docker, or on the host in tests. <!-- code: src/sandbox.ts#Sandbox tests/doubles/sandbox.ts#hostSandbox -->
- The session talks to a harness, or replays a script in tests. <!-- code: src/session.ts#Session tests/doubles/session.ts#replaySession -->

## Engine code and model judgment

| Engine code | Model judgment |
| --- | --- |
| Step transitions, tries and rounds | Edits and proposals |
| Script checks and failure modes | Judge results |
| Proposal validation and application | Whether `until` holds |
| Push safety, triggers and trust | Questions for people |

A malformed reply fails the try. `transition` maps a workflow, a run and an outcome to the next run, with no clock or I/O; `drive` does the reads and writes around it. Proposals are the only write path. <!-- code: src/workflow.ts#transition src/engine.ts#land src/engine.ts#tick src/engine.ts#drive -->

Graph files decode strictly: a bad reference or unknown key fails `check` with its path before anything runs. <!-- code: src/folder.ts#loadGraph -->

## Names

An exported function starts with one of these verbs:

- `parse` turns text into a value, `compile` into a checked value or its problems, `format` a value into text for people. None do IO.
- `make` builds a value from parts (`makePostableProposal`); `get` takes or looks up a part; `pick` chooses by a rule; `split` cuts; `sum` adds.
- `find` searches a collection or folder tree, reading but never writing.
- `is` answers a boolean and `why` a reason or undefined.
- `read` does IO in. `write`, `append`, `copy`, `move` and `remove` change files, volumes or containers; `create` brings an outside resource into being; `ensure` acts only when a condition does not hold yet.
- `run` runs to the end, `start` begins something that keeps going, `wait` blocks on a condition, `scan` is one pass over open issues, `queue` enqueues, `propose` answers proposals; `commit` and `merge` are git's.
- `use` names a React hook.

The other naming rules are in [STYLE.md](../STYLE.md#naming). <!-- code: bin/style.mjs#verbs -->

## Before you commit

`npm run check` is what CI and the commit hook run: format, lint, unused code, docs, example graphs, types, tests and the studio build. `npm run hooks` turns the hooks on. `sh bin/precommit.sh` runs the agentgraph example's fast checks on the uncommitted change against `HEAD`, or `AGENTGRAPH_BASE`.

Docs tie claims to code with hidden `<!-- code: src/engine.ts#land -->` comments. `node bin/refs.mjs` fails on a missing file or symbol, `--coverage` on a field, value, status, proposal kind, flag or `AGENTGRAPH_` variable in no docs code span, and `--diff main` lists pairs changed on one side only. `node bin/commands.mjs` fails on documented commands, flags or scripts that do not exist.

`bin/lsp.ts` gives find references and rename from the shell through the TypeScript language server. Positions are `file:line:col` from 1.

```sh
node bin/lsp.ts refs src/disk.ts:374:14
node bin/lsp.ts rename src/disk.ts:374:14 roomLeft --dry   # print the edits, change nothing
node bin/lsp.ts rename-symbol inventory listItems          # find the declaration by name
```
