# Patterns

The conventions the bothub core follows, each with one place it shows.

## Schemas first

An Effect schema is the only definition of a hub file, and its TypeScript type is inferred from it.
Variants are derived where they are used, never written out as a second type that can drift.

See `Bot` in [core/src/hub.ts](../core/src/hub.ts).

## Proposals are the only write path

Agents never write to GitHub themselves. An agent proposes, the step's `returns` decides what is
accepted, and the engine applies the accepted ones after the checks pass.

See `land` in [core/src/engine.ts](../core/src/engine.ts).

## The state machine is pure

`transition` takes a workflow, a run and how a try ended, and returns the next run. It reads no
clock and does no I/O, so every path through a workflow is a plain test.

See `transition` in [core/src/workflow.ts](../core/src/workflow.ts).

## Fail closed

An unknown key, a missing agent or a check that does not exist is an error
before anything runs. A reply without the proposals it owes fails the try. A check that cannot run
fails.

See `loadHub` in [core/src/hub.ts](../core/src/hub.ts).

## Services with doubles

The forge, store, session and sandbox are Effect services. Production uses GitHub, files, docker and
the harnesses. Tests use a forge in a folder, a scripted session and a sandbox on the host, so whole
runs are tested without a network.

See `fileForge` in [core/src/forge.ts](../core/src/forge.ts).

## Unknown keys name their replacement

A removed key is reported with what to write instead.

See `gone` in [core/src/hub.ts](../core/src/hub.ts).

## Secrets stay out of argv and logs

A session gets only its own agent's key, passed by name, so the value never appears in a command line.

See `spawned` in [core/src/sandbox.ts](../core/src/sandbox.ts).

## Few dependencies

bothub composes existing programs (the harness, LiteLLM, docker, git) and a few libraries.

See [package.json](../package.json).

## Strict TypeScript

`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on, and only erasable syntax is
allowed, so Node runs the source directly without a build step.

See [tsconfig.json](../tsconfig.json).

## Short comments

A TSDoc block says what an export does in a sentence or two; inline comments only appear where the
code is unclear. Reasons live in research notes, not in the code.
