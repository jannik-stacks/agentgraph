# Patterns

The conventions the engine follows, each with one place it shows.

## Schemas first

An Effect schema is the only definition of a hub file. Its TypeScript type is inferred from it. Variants are derived where they are used, never written as a second type that could drift.

<!-- code: src/hub.ts#Agent -->

## Proposals are the only write path

Agents never write to GitHub themselves. An agent proposes, its `returns` decides what is accepted, and the engine applies accepted proposals after the checks pass.

<!-- code: src/engine.ts#land -->

## The state machine is pure

`transition` takes a workflow, a run and how a try ended, and returns the next run. It reads no clock and does no I/O, so every path through a workflow is a plain test.

<!-- code: src/workflow.ts#transition -->

## Fail closed

An unknown key, a missing agent or a check that does not exist is an error before anything runs. A reply without the proposals it owes fails the try. A check that cannot run fails.

<!-- code: src/hub.ts#loadHub -->

## Services with doubles

The forge, store, session and sandbox are Effect services. Production uses GitHub, files, docker and the harnesses. Tests use a forge in a folder, a scripted session and a sandbox on the host, so whole runs are tested without a network. The forge folder also runs agentgraph locally without GitHub.

<!-- code: src/forge.ts#fileForge -->

## Unknown keys name their replacement

A removed key is reported with what to write instead.

<!-- code: src/hub.ts#gone -->

## Secrets stay out of argv and logs

A session gets only its own agent's key, passed to docker by name, so the value never shows in a command line. The harness output masks it.

<!-- code: src/docker.ts#dockerArgs -->

## Few dependencies

agentgraph composes existing programs (the harness, LiteLLM, docker, git) and a few libraries.

See [package.json](../package.json).

## Strict TypeScript

`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on. Only erasable syntax is allowed, so Node runs the source directly with no build step.

See [tsconfig.json](../tsconfig.json).

## Short comments

A TSDoc block says what an export does in a sentence or two. Inline comments appear only where the code is unclear. Reasons live in research notes, not in code.
