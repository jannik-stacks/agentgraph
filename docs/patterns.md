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

Forge, store, session and sandbox are Effect services with [test doubles](architecture.md#where-everything-lives). Whole runs test without network access; the file forge also supports local use. <!-- code: src/forge.ts#fileForge -->

## Unknown keys name their replacement

Retired keys report what to write instead. <!-- code: src/hub.ts#gone -->

## Secrets stay out of argv and logs

Agent keys pass by environment name and are masked in output; see [Models](sandbox.md#models). <!-- code: src/docker.ts#dockerArgs -->

## Few dependencies

Compose harnesses, LiteLLM, Docker and git with a few [libraries](../package.json).

## Built-ins before helpers

Engine code in `src/` uses Effect's own combinators: `Effect.timeoutFail` for timeouts, and interruption kills the child. Scripts in `bin/` and `tune/` use Node's: `node:timers/promises` to wait, spawn's `timeout` or `signal` option to stop a child, `util.parseEnv` for env files. Nobody writes their own sleep, timer pair or parser. <!-- code: tune/skill.ts#session -->

## Strict TypeScript

`exactOptionalPropertyTypes`, `noUncheckedIndexedAccess` and erasable syntax let Node run source without a build. See [tsconfig.json](../tsconfig.json).

## Short comments

TSDoc briefly describes exports. Inline comments explain unclear code; rationale belongs in research notes.
