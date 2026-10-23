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

Forge, store, session and sandbox are Effect services. Tests swap in a scripted session, a host sandbox, the file forge and the file store, so whole runs test without network access. <!-- code: src/forge.ts#fileForge -->

## Test code stays out of src

`src` holds only production code. A test double lives in `tests/doubles/` under the name of the `src` file it stands in for. `npm run knip` includes `knip --production`, which fails on a `src` export only tests use; an export kept for a unit test says so with `@internal`. <!-- code: tests/doubles/sandbox.ts#host tests/doubles/session.ts#scripted -->

## Hub files decode strictly

An unknown or removed key fails `check` with its path, except in skill frontmatter, where keys other than `description` and `uses` are ignored. Nothing reads an older hub shape. <!-- code: src/hub.ts#loadHub -->

## Secrets stay out of argv and logs

Agent keys pass by environment name and are masked in output; see [Models](sandbox.md#models). <!-- code: src/docker.ts#dockerArgs -->

## Few dependencies

Compose harnesses, LiteLLM, Docker and git with a few [libraries](../package.json).

## Built-ins before helpers

Engine code in `src/` uses Effect's combinators: `Effect.timeoutFail` for timeouts, and interruption kills the child. Scripts in `bin/` and `tune/` use Node's: `node:timers/promises` to wait, spawn's `timeout` or `signal` option to stop a child, `util.parseEnv` for env files. New code does not add its own sleep, timer pair or parser. <!-- code: tune/skill.ts#session -->

## Strict TypeScript

`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and erasable syntax let Node run source without a build. See [tsconfig.json](../tsconfig.json).

## Short comments

TSDoc briefly says what an export does. Inline comments explain unclear code; rationale belongs in research notes.

## Before you commit

`npm run check` is what CI and the commit hook run: formatting, lint, unused code, docs checks, example hubs, types, tests with coverage and the studio build. Part of it is `sh bin/precommit.sh`, which runs the agentgraph hub's fast checks over the uncommitted change against `HEAD`, or `AGENTGRAPH_BASE` when set. `npm run hooks` turns the hook on.

Docs tie claims to code with hidden comments such as `<!-- code: src/engine.ts#land -->`. `node bin/refs.mjs` fails when one names a missing file or symbol. `node bin/refs.mjs --coverage` fails when a user-facing name (a hub field or value, a status, a proposal kind, a CLI flag or an `AGENTGRAPH_` variable) appears in no docs code span. `node bin/refs.mjs --diff main` lists the other side of each pair that changed on one side only. `node bin/commands.mjs` fails on documented commands, flags or npm scripts that do not exist.
