# Engine and code

The engine lives in `src/`. Repository development rules are in [STYLE.md](../STYLE.md).

## Where everything lives

The host drives runs and tracker writes; runners execute commands. The store saves state and traces. The studio reads graphs and runs. <!-- code: src/main.ts#start -->

| Service | Responsibility |
| --- | --- |
| Tracker | Read issues; apply proposals on GitHub or in folders |
| Store | Save runs, results and traces |
| Sandbox | Manage mirrors and checkouts; execute through runners |
| Session | Talk to harnesses |

Each service has a test stand-in. Sandbox tests use `hostSandbox`; session tests use `replaySession`. <!-- code: src/tracker.ts#Tracker src/store.ts#Store src/sandbox.ts#Sandbox src/mirror.ts#makeSandbox src/sandbox.ts#Runner src/session.ts#Session tests/doubles/sandbox.ts#hostSandbox tests/doubles/session.ts#replaySession -->

## Engine code and model judgment

The engine validates graphs, proposals and results, runs checks and controls transitions. Agents edit files, request actions and supply judged results. Invalid replies fail the try. `transition` computes the next run without I/O; `runWorkflow` performs the surrounding work. <!-- code: src/workflow.ts#transition src/run/settle.ts#writeProposals src/run/trigger.ts#tick src/run/drive.ts#runWorkflow -->

[Graph validation](reference.md) rejects unknown keys and invalid references before runs. <!-- code: src/folder.ts#loadGraph -->

## Names

Exported functions must start with a verb from the [STYLE naming rules](../STYLE.md#naming). <!-- code: bin/style.mjs#verbs -->

## Before you commit

Pass `npm run check:static` before commits and `npm run check` before merge. Install hooks with `npm run hooks`. Run example checks with `sh bin/precommit.sh`.

`node bin/refs.mjs` checks code anchors. Its `--coverage` flag checks documented names; `--diff main` lists changed pairs of docs and code. `node bin/commands.mjs` checks documented commands.

Studio status pills render `<!-- unfinished -->` and `<!-- untested -->`. Browser tests visibly skip with reasons when Chrome or Chromium is unavailable. <!-- code: studio/src/Markdown.tsx#remarkStatus studio/src/Markdown.tsx#rehypeStatus tests/studio-controls.e2e.test.ts#startBrowser -->

`bin/lsp.ts` finds TypeScript references and renames symbols. Positions use `file:line:col`, counted from 1. `symbol` prints where a name is declared; `rename-symbol` renames it when exactly one declaration matches.

```sh
node bin/lsp.ts refs <file>:<line>:<col>
node bin/lsp.ts rename <file>:<line>:<col> <newName> [--dry]
node bin/lsp.ts symbol <name>
node bin/lsp.ts rename-symbol <name> <newName> [--dry]
```
