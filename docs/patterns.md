# Patterns

The conventions the bothub code follows, each with one place it shows.

## Schemas first

A zod schema is the only definition of a hub file, and its TypeScript type is inferred from it.
Variants are derived where they are used, with `Pick`, `Omit`, `Partial` or a small generic, never
written out as a second interface that can drift.

See `Defined` in [src/config.ts](../src/config.ts).

## Proposals are the only write path

Bots never write to GitHub or the hub themselves; tools only read. A bot proposes, the job's
allowlist decides what is accepted (`validate`), and apply journals every planned
effect as `pending` before carrying out the first one.

See `apply` in [src/apply.ts](../src/apply.ts).

## Idempotent effects

Every effect has a key built from the event, the job and the proposal. Written comments and issues
carry it as a hidden marker, so applying the same thing again finds it instead of posting twice.
The same goes for deliveries: the store records every event id it has dispatched.

See `comment` in [src/apply.ts](../src/apply.ts).

## Fail closed

Nothing passes by default. A check that cannot decide fails with the reason. A check that applies
to nothing in the change is skipped, but fails once no gating check ran at all. An `over` script
that fails or prints more than `max` items fails its check. A `decide` check that gets no answer,
because the model is unreachable, fails with a server error or says nothing readable, is blocked.

See `decideCheck` in [src/decide.ts](../src/decide.ts).

## Harness adapters are pure

An adapter maps a `RunSpec` to an argv and parses one output line into common

`AgentEvent` values. It spawns nothing and holds no state, so the runner, the sandbox and the sim share one
code path and adapters are tested with recorded output.

See `command` in [src/harnesses/pi.ts](../src/harnesses/pi.ts).

## Effect where it earns it

Effect carries process lifetimes, streams, timeouts and concurrency limits, where its resource
safety pays off. Plain async functions do the rest.

See `output` in [src/runner.ts](../src/runner.ts).

## Secrets stay out of argv and logs

A harness gets only the secrets its bot is granted (`secretsFor`). In a container
they are passed by name, so their values never appear in a command line, and every stored
transcript is masked afterwards.

See `masker` in [src/runner.ts](../src/runner.ts).

## A home per run

Each harness runs with its own home and XDG directories inside the run's folder, so nothing leaks
between runs or from the host user's config, and transcripts stay with the run.

See `homeEnv` in [src/runner.ts](../src/runner.ts).

## Injectable edges

Code that talks to the network or reads the clock takes `fetch` and `now` as optional parameters
with the real ones as defaults. Tests pass fakes; callers pass nothing.

See `githubApp` in [src/github-app.ts](../src/github-app.ts).

## Scenarios with faults

Whole workflows are tested end to end with `bothub sim`. A scenario can crash the process after a
given number of effects, redeliver the event or make an effect fail; after a crash the sim
restarts, reconciles and retries, the way a real hub recovers.

See `Faults` in [src/sim.ts](../src/sim.ts).

## Few dependencies

bothub composes existing programs (the harness, LiteLLM, docker, git) and four runtime libraries
instead of growing its own layers. A layer has to earn its place.

See [package.json](../package.json).

## Strict TypeScript

`exactOptionalPropertyTypes` and `noUncheckedIndexedAccess` are on, and only erasable syntax is
allowed, so Node runs the source directly without a build step.

See [tsconfig.json](../tsconfig.json).

## Short comments

A TSDoc block says what an export does in a sentence or two; inline comments only appear where the
code is unclear. Reasons and history live in the docs, not in the code.

See `marker` in [src/apply.ts](../src/apply.ts).
