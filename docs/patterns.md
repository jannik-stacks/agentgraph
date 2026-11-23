# Conventions

Use this guide when naming a change, choosing where it belongs and deciding how to test it.
[Architecture](architecture.md) follows the engine through a run, [Types and schemas](types.md) describes the data and [Code layout](layout.md) maps the layers.

## Names

Choose a verb that tells the caller what to expect. The full set for exported functions is:

- `parse`, `compile`, `format`, `make`, `get`, `find`, `pick`, `split`, `sum`, `is`, `why`
- `read`, `write`, `append`, `copy`, `move`, `remove`, `create`, `ensure`
- `run`, `start`, `wait`, `scan`, `queue`, `propose`, `commit`, `merge`, `use`

<!-- code: bin/style.mjs#verbs -->

A predicate such as `isParked` answers yes or no. `whyRunnerRefuses` returns an Effect that yields the reason or `undefined`.
Avoid `Of`, `For` and `From` inside a name. A preposition directly after the leading verb is allowed, as in `waitForLock`. <!-- code: src/run/settle.ts#isParked src/services.ts#whyRunnerRefuses src/owner.ts#waitForLock STYLE.md -->

Give a type a qualifier and a spelled-out noun. Rule 13 reserves suffixes by meaning.
A `Spec` describes an input, a `Result` is what an action returns, an `Entry` is one keyed record and `Settings` describes configuration. See the [naming rules](../STYLE.md#naming). <!-- code: STYLE.md src/types.ts#SessionSpec src/types.ts#CheckResult src/types.ts#CheckEntry -->

Layer constructors such as `folderTracker`, `githubTracker`, `fileStore`, `harnessSession`, `dockerRunner` and `boxRunner` read as values supplied to Effect.
Harness and auth plugins take names such as `claude` and `token`. Consult the [listed exceptions](../STYLE.md#exceptions) before introducing one. <!-- code: bin/style.mjs#exempt src/auths.ts#token STYLE.md -->

Use the short [project terms](index.md#terms) in `src/`. In the CLI, Bench, Tune, studio and test doubles, spell out the purpose so the name makes sense at the edge.
The retired word list lives in `src/retired.ts`. After a rename, run `node bin/style.mjs --write` to remove the baseline entries it fixed. <!-- code: bin/style.mjs src/retired.ts#retiredWords STYLE.md -->

## Types

Define external input with an Effect schema and derive its TypeScript type with `typeof X.Type`. Derive narrower shapes at the use site. Put case-specific fields on the matching member of a tagged union. See [Types and schemas](types.md) for examples and [rules 1 to 6](../STYLE.md#types) for the conventions. <!-- code: src/types.ts#Agent src/actions.ts#ServedRun src/types.ts#Waiting STYLE.md -->

Report unknown input with the offending path. Use defaults only for fields that define them. See [graph validation](reference.md). <!-- code: src/folder.ts#loadGraph src/workflow.ts#compileWorkflow -->

## Where code goes

Put a decision about events or outcomes in a pure function in `workflow.ts`. Let the engine read inputs, call the function and write the result.
Follow the [import boundaries](layout.md#layers-in-src) when choosing a caller. The engine reaches adapters through its services. <!-- code: src/workflow.ts#getEventOutcome src/workflow.ts#transition src/run/drive.ts#runWorkflow .oxlintrc.json -->

Put a replaceable implementation behind a plugin. `makePlugin` accepts a tracker, runner, auth implementation, tools, hooks under `on`, or a studio page.
Add a settings field when there is data to consume. The field checker looks for schema fields with no reader. <!-- code: src/plugin.ts#makePlugin src/trackers.ts src/runners.ts#local src/auths.ts#token bin/fields.mjs -->

Represent a failure with a tagged error and handle its tag with `Effect.catchTag`. A skip needs a visible status, a count and a reason.
Put explanations in anchored docs. Code comments are limited to `// UNEXPECTED: <what and why>`; reserve TSDoc for the published entries and their re-exports.
Use the current shape directly and keep historical names and readers in git history. See [rules 18 to 21](../STYLE.md#comments-and-docs-links) and [rule 32](../STYLE.md#simplicity-and-reuse). <!-- code: src/types.ts#TrackerError src/run/settle.ts#writeProposals package.json STYLE.md -->

## Tests

Vitest puts tests in two projects. The unit project takes the ordinary test files. The tools project lists its suites by filename and gives tests and hooks 120 seconds for work such as running git, a stand-in server or the CLI.
Coverage includes `src/` and `harnesses/` with a 90 percent line threshold. <!-- code: vitest.config.ts -->

Start with the real tracker and store for a drive test. The helpers in `tests/world.ts` assemble the rest:

1. Call `world()` to seed a git repository, a folder tracker and issue 7 with an agent request.
2. Supply scripted turns to `services(where, turns)`. It combines the folder tracker and file store with `hostSandbox` and `replaySession`. The sandbox runs commands in a host worktree, and the session replays harness events.
3. Drive `tick` or `runWorkflow`. Inspect the trace for the decision, the tracker folder for its public effect and recorded commands for the work that ran.

<!-- code: tests/world.ts#world tests/world.ts#services tests/doubles/sandbox.ts#hostSandbox tests/doubles/session.ts#replaySession -->

Keep service doubles in `tests/doubles/` under the name of the source they replace. The directory also holds a local box server.
`tests/kit.ts` supplies `makeRun`, `tmp`, `git` and `commit`. Use the graph fixtures and the `start`, `wrote`, `reply`, `result` and `stop` events in `tests/fixtures.ts` to describe a conversation. <!-- code: tests/doubles/box.ts#startBoxServer tests/kit.ts#makeRun tests/fixtures.ts#reply -->

`tests/docs.test.ts` checks links, code fences, the plugin example, run fields and written rules as part of the test suite. <!-- code: tests/docs.test.ts -->

Assert outside loops and branches. Use an `it.each` row per case, or collect the results and assert once. The test-guards check enforces [rule 34](../STYLE.md#layout). <!-- code: examples/agentgraph/scripts/test-guards.mjs STYLE.md -->

The Docker end-to-end suites require `AGENTGRAPH_E2E=1` and the local image `agentgraph-sandbox:local`. The studio browser suite skips when it cannot find Chrome or Chromium and includes the reason in the suite name. <!-- code: tests/sandbox-smoke.e2e.test.ts tests/readonly.e2e.test.ts tests/studio-controls.e2e.test.ts -->

## Checks before a commit

| Command | What it runs or reports | When |
| --- | --- | --- |
| `npx vitest run tests/<file>.test.ts` | The test file your change touches. | While editing. |
| `npm run check:docs` | Code anchors, documented commands, schema field usage, and standalone style checks for names. | After changing docs or their source. |
| `node bin/refs.mjs --diff main` | Docs and code pairs where only one side changed. | When reviewing a branch. |
| `node bin/refs.mjs --coverage` | User-facing names missing from the docs. | When editing fields, values, commands or settings. |
| `npm run check:static` | oxfmt, oxlint, knip, docs and example checks, the precommit script, and TypeScript for the engine and studio. | Before each commit. Install the hook with `npm run hooks`. |
| `npm run check` | Static checks, the studio build and all tests with coverage. | Once per branch before merge. |

<!-- code: package.json bin/check.sh bin/precommit.sh bin/refs.mjs bin/commands.mjs bin/fields.mjs bin/style.mjs -->

Oxlint enforces the comment rule in `npm run lint` and `npm run check:static`. Use `npm run format` to fix formatting reported by the static check's `oxfmt --check`. See the [rule and tool table](../STYLE.md#lint-and-enforcement). <!-- code: package.json bin/style.mjs .oxlintrc.json STYLE.md -->

Studio status pills render `<!-- unfinished -->` and `<!-- untested -->`. <!-- code: studio/src/Markdown.tsx#remarkStatus studio/src/Markdown.tsx#rehypeStatus -->

`bin/lsp.ts` finds TypeScript references and renames symbols. Positions use `file:line:col`, counted from 1. The `symbol` command prints where a name is declared. The `rename-symbol` command renames it when exactly one declaration matches. <!-- code: bin/lsp.ts -->

```sh
node bin/lsp.ts refs <file>:<line>:<col>
node bin/lsp.ts rename <file>:<line>:<col> <newName> [--dry]
node bin/lsp.ts symbol <name>
node bin/lsp.ts rename-symbol <name> <newName> [--dry]
```

## Changesets and commits

For a user-facing change, run `npx changeset` and write one or two plain lines. Commit the file in `.changeset/` with the change.
Choose a patch while the package stays on 0.0.x, even for a breaking change. See [Releasing](../AGENTS.md#releasing). <!-- code: AGENTS.md .github/workflows/release.yml -->

Keep commits small and linear. Give each one a conventional subject line and, when needed, one to three lines explaining why. The commit message hook checks the text.
Pull requests merge by rebase. Finish each implementation with the reduce pass in [rule 33](../STYLE.md#simplicity-and-reuse): remove dead code, unnecessary exports and duplicate definitions. <!-- code: bin/commit-msg.mjs STYLE.md AGENTS.md -->
