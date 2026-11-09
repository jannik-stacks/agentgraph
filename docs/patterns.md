# Engine and code

The engine lives in `src/`. Repository development rules are in [STYLE.md](../STYLE.md).

## Where everything lives

The host drives runs and applies tracker writes. A runner executes sandbox commands; the store keeps run state and traces. The studio reads the graph and run data. <!-- code: src/main.ts#start -->

Four services separate the engine from I/O:

| Service | Responsibility |
| --- | --- |
| Tracker | Read issues and apply proposals on GitHub or in a folder |
| Store | Save runs, results and traces |
| Sandbox | Manage the mirror and checkouts; execute commands through a runner |
| Session | Talk to a harness |

Each service has a test stand-in. Sandbox tests use `hostSandbox`; session tests use `replaySession`. <!-- code: src/tracker.ts#Tracker src/store.ts#Store src/sandbox.ts#Sandbox src/mirror.ts#makeSandbox src/sandbox.ts#Runner src/session.ts#Session tests/doubles/sandbox.ts#hostSandbox tests/doubles/session.ts#replaySession -->

## Engine code and model judgment

The engine validates graph files, proposals and results, runs checks and controls transitions. Agents edit files, request actions and supply judged results. `transition` computes the next run without I/O; `runWorkflow` performs the surrounding work. Invalid replies fail the try. <!-- code: src/workflow.ts#transition src/run/settle.ts#writeProposals src/run/trigger.ts#tick src/run/drive.ts#runWorkflow -->

Unknown graph keys and invalid references fail validation before a run starts. <!-- code: src/folder.ts#loadGraph -->

## Names

This repository requires exported functions to start with one of these verbs:

- `parse` turns text into a value; `compile` checks it; `format` makes display text. These do no I/O.
- `make` builds a value; `get` looks up a part; `pick` chooses; `split` cuts; `sum` adds.
- `find` searches, reading but never writing; `is` returns a boolean; `why` returns a reason or undefined.
- `read` does input; `write`, `append`, `copy`, `move` and `remove` change resources; `create` brings one into being; `ensure` acts when needed.
- `run` finishes work; `start` begins ongoing work; `wait` blocks; `scan` makes one issue pass; `queue` enqueues; `propose` answers proposals; `commit` and `merge` are git operations.
- `use` names a React hook.

See [naming rules](../STYLE.md#naming). <!-- code: bin/style.mjs#verbs -->

## Before you commit

`npm run check:static` runs the commit checks. `npm run check` also runs tests and builds the studio; it must pass before merge. `npm run hooks` installs the hooks. `sh bin/precommit.sh` runs this repository's example checks on the uncommitted diff.

Docs use hidden code anchors. `node bin/refs.mjs` checks them; `--coverage` checks documented names and `--diff main` lists changed pairs. `node bin/commands.mjs` checks documented commands.

The studio renders `<!-- unfinished -->` and `<!-- untested -->` as status pills. Browser interaction tests visibly skip with a reason when Chrome or Chromium is unavailable. <!-- code: studio/src/Markdown.tsx#remarkStatus studio/src/Markdown.tsx#rehypeStatus tests/studio-controls.e2e.test.ts#startBrowser -->

`bin/lsp.ts` provides shell access to TypeScript references and renames; positions use `file:line:col`, counted from 1.
