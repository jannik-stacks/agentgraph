# Patterns

## Schemas first

Effect schemas define hub files and infer TypeScript types. Derive variants at use sites rather than duplicating types. <!-- code: src/hub.ts#Agent -->

## Proposals are the only write path

Agents request writes through the [proposal protocol](proposals.md). <!-- code: src/engine.ts#land -->

## The state machine is pure

`transition` maps workflow, run and outcome to the next run without clocks or I/O. <!-- code: src/workflow.ts#transition -->

## Fail closed

Bad hub references fail before execution. Missing required proposals fail the try; unavailable checks cannot pass. <!-- code: src/hub.ts#loadHub -->

## Services with doubles

The engine reaches the outside only through the [four services](architecture.md#where-everything-lives), so whole runs test without network access. <!-- code: src/forge.ts#fileForge -->

## Test code stays out of src

`src` holds only production code. A test double lives in `tests/doubles/` under the name of the `src` file it stands in for. `npm run knip` includes `knip --production`, which fails on a `src` export only tests use; an export kept for a unit test says so with `@internal`. <!-- code: tests/doubles/sandbox.ts#hostSandbox tests/doubles/session.ts#replaySession -->

## Hub files decode strictly

An unknown or removed key fails `check` with its path, except in skill frontmatter, where keys other than `description` and `uses` are ignored. Nothing reads an older hub shape. <!-- code: src/hub.ts#loadHub -->

## Secrets stay out of argv and logs

See [Models](sandbox.md#models) for how agent keys travel. <!-- code: src/docker.ts#dockerArgs -->

## Few dependencies

Compose harnesses, LiteLLM, Docker and git with a few [libraries](../package.json).

## Built-ins before helpers

Engine code in `src/` uses Effect's combinators: `Effect.timeoutFail` for timeouts, and interruption kills the child. Scripts in `bin/` and `tune/` use Node's: `node:timers/promises` to wait, spawn's `timeout` or `signal` option to stop a child, `util.parseEnv` for env files. New code does not add its own sleep, timer pair or parser. <!-- code: tune/skill.ts#session -->

## Strict TypeScript

`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and erasable syntax let Node run source without a build. See [tsconfig.json](../tsconfig.json).

## Names

Names follow one small vocabulary so a reader can guess what a function does from its first word. An exported function starts with one of these verbs:

- `parse` turns text into a value; `compile` turns text into a checked value or its problems; `format` turns a value into text for people. None of them do IO.
- `make` builds a new value from parts, including a value reshaped for a boundary such as a post (`makePostableProposal`), so there is no `prepare`; `get` takes a part of a value or looks one up in a table; `pick` chooses some candidates by a rule; `split` cuts one value into parts; `sum` adds numbers up.
- `find` searches a collection or a directory tree; it may read but never writes.
- `is` answers a boolean and `why` answers a reason or undefined: `isAgentBranch`, `whyUnpushable`.
- `read` does IO in, from disk, the environment, git or the network. `write`, `append`, `copy`, `move` and `remove` change files, directories, volumes or containers. `create` brings an outside resource into being, such as a docker volume. `ensure` makes a condition true and acts only when needed.
- `run` runs a process, step or loop to its end; `start` begins something that keeps going; `wait` blocks until a condition holds; `scan` is one pass over every open issue; `queue` puts work on a queue for a later loop; `propose` answers proposals; `commit` and `merge` are git's.
- `use` names a React hook.

Components and types are a qualifier plus a noun, spelled out: `RunLink`, `DiskCacheEntry`, `SandboxSetup`, never `Mark`, `Item` or `RepoSetup`. A type never reuses a name another export has, and never shadows Effect or the platform (`TokenScope`, not `Scope`). Type suffixes mean one thing each: `Spec` is an input describing what to make, `Result` is what one action hands back, `Entry` is one keyed record of a cache, store or log, `Settings` is configuration, `Point` is a position, and `Lookup` answers a value for a key; there is no `Index` or `Map` suffix. Layer constructors are `<how><Service>` with no verb (`fileForge`, `replaySession`), the one exception in [STYLE.md](../STYLE.md#exceptions). No name ends in `Of` or `For`; say what the function does instead.

Core code in `src/` uses the short domain words from the [vocabulary](vocabulary.md). Edge code (bench, tune, studio pages, `bin/` helpers, hub scripts, test doubles) uses long names that explain themselves to someone who never opened the file: `readArmUsageOverAttempts`. The words users type in workflow and check files stay short (`back`, `until`, `tries`, `judge`); TypeScript types may qualify them (`CheckJudge`).

`npm run lint` enforces the verb, `xOf` and one-name-per-export rules and warns on retired words, through the oxlint plugin in `bin/style.mjs`. Violations from before the rules sit in `bin/style-baseline.txt`; `node bin/style.mjs` fails when that file lists one that is fixed, and `node bin/style.mjs --write` rewrites it. <!-- code: bin/style.mjs#verbs -->

## No code comments

Docs pages say what code does and why; code says it with names and types. The one exception is something surprising the code cannot say, written `// UNEXPECTED: <what and why>`. TSDoc is a comment too. Lint directives (`oxlint-`, `@ts-`) and knip's `@internal` tag stay. `npm run lint` fails on any other comment beyond a file's count in the baseline.

## Before you commit

`npm run check` is what CI and the commit hook run: formatting, lint, unused code, docs checks, example hubs, types, tests with coverage and the studio build. Part of it is `sh bin/precommit.sh`, which runs the agentgraph hub's fast checks over the uncommitted change against `HEAD`, or `AGENTGRAPH_BASE` when set. `npm run hooks` turns the hook on.

Docs tie claims to code with hidden comments such as `<!-- code: src/engine.ts#land -->`. `node bin/refs.mjs` fails when one names a missing file or symbol. `node bin/refs.mjs --coverage` fails when a user-facing name (a hub field or value, a status, a proposal kind, a CLI flag or an `AGENTGRAPH_` variable) appears in no docs code span. `node bin/refs.mjs --diff main` lists the other side of each pair that changed on one side only. `node bin/commands.mjs` fails on documented commands, flags or npm scripts that do not exist.
