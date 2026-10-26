# Engine and code

The engine is the runner code in `src/`. The code rules are in [STYLE.md](../STYLE.md); this page shows how the engine is put together.

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

The engine reaches the outside only through four services, each with a stand-in, so whole runs test without network:

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

Models supply proposals and results; the engine decides the transitions, and a malformed reply fails the try. `transition` maps a workflow, a run and an outcome to the next run, with no clock or I/O. `drive` does the reads and writes around it. Proposals are the only write path. <!-- code: src/workflow.ts#transition src/engine.ts#land src/engine.ts#tick src/engine.ts#drive -->

Bad graph references fail before anything runs. Graph files decode strictly: an unknown or removed key fails `check` with its path, and nothing reads an older shape. <!-- code: src/folder.ts#loadGraph -->

## Names

Names follow one small vocabulary, so a reader can guess what a function does from its first word. An exported function starts with one of these verbs:

- `parse` turns text into a value; `compile` turns text into a checked value or its problems; `format` turns a value into text for people. None of them do IO.
- `make` builds a new value from parts, including a value reshaped for a boundary (`makePostableProposal`); `get` takes a part of a value or looks one up; `pick` chooses some candidates by a rule; `split` cuts a value into parts; `sum` adds numbers up.
- `find` searches a collection or a directory tree; it may read but never writes.
- `is` answers a boolean and `why` a reason or undefined: `isAgentBranch`, `whyUnpushable`.
- `read` does IO in, from disk, the environment, git or the network. `write`, `append`, `copy`, `move` and `remove` change files, volumes or containers. `create` brings an outside resource into being. `ensure` makes a condition true and acts only when needed.
- `run` runs a process, step or loop to its end; `start` begins something that keeps going; `wait` blocks until a condition holds; `scan` is one pass over every open issue; `queue` puts work on a queue; `propose` answers proposals; `commit` and `merge` are git's.
- `use` names a React hook.

The other naming rules are in [STYLE.md](../STYLE.md#naming). <!-- code: bin/style.mjs#verbs -->

## Before you commit

`npm run check` is what CI and the commit hook run: formatting, lint, unused code, docs checks, example graphs, types, tests with coverage and the studio build. `npm run hooks` turns the hooks on; `git config --unset core.hooksPath` turns them off. Part of the check is `sh bin/precommit.sh`, which runs the agentgraph example's fast checks over the uncommitted change against `HEAD`, or `AGENTGRAPH_BASE`.

Docs tie claims to code with hidden comments such as `<!-- code: src/engine.ts#land -->`.

- `node bin/refs.mjs` fails when one names a missing file or symbol.
- `node bin/refs.mjs --coverage` fails when a graph field or value, a status, a proposal kind, a CLI flag or an `AGENTGRAPH_` variable appears in no docs code span.
- `node bin/refs.mjs --diff main` lists the other side of each pair that changed on one side only.
- `node bin/commands.mjs` fails on documented commands, flags or npm scripts that do not exist.

`bin/lsp.ts` gives you the editor's find references and rename from the shell, through the TypeScript language server in the dev dependencies. Positions are `file:line:col`, counted from 1.

```sh
node bin/lsp.ts refs src/disk.ts:374:14
node bin/lsp.ts rename src/disk.ts:374:14 roomLeft --dry   # print the edits, change nothing
node bin/lsp.ts rename-symbol inventory listItems          # find the declaration by name
```
