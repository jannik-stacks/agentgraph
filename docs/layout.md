# Code layout

Use this map to find the owner of a change and check which files it can import.
For the execution path see [Architecture](architecture.md), for shared shapes see [Types and schemas](types.md), and for working rules see [Conventions](patterns.md).

## Top-level folders

| Folder | What lives here |
| --- | --- |
| `src/` | The engine's production TypeScript, including its services and adapters. |
| `bin/` | The CLI entry point and the repository's development tools. |
| `harnesses/` | Shipped harness and model provider definitions wired into `agentgraph.config.ts`. |
| `studio/` | The clone's web server and browser UI. |
| `tests/` | Vitest suites, shared fixtures and service replacements in `tests/doubles/`. |
| `examples/` | The starter, sandbox, agentgraph and Bench graphs, example plugins, a dashboard and deployment files. |
| `infra/` | The local Compose stack, model gateway, egress proxy, image sources and price table. GitHub App key helpers live in `infra/github/`. |
| `bench/`, `tune/` | Clone-only workflow comparison and graph tuning tools. See [Bench](bench.md). |
| `skills/` | Instructions for setting up and tuning a graph. |
| `docs/` | The Markdown pages the studio also displays. |

<!-- code: package.json bin/run.ts src/main.ts#start agentgraph.config.ts vitest.config.ts infra/local/docker-compose.yml studio/src/docs/DocsPage.tsx -->

The npm package ships `dist/`, the starter graph and selected local sandbox, egress and price files.
`npm run build` bundles the CLI from `bin/run.ts` to `dist/run.mjs`. It also builds the three public entries from `src/plugin.ts`, `src/trackers.ts` and `src/runners.ts`, with their declarations.
<!-- code: package.json bin/run.ts src/plugin.ts#makePlugin src/trackers.ts src/runners.ts -->

## Layers in src

Read the table from top to bottom. A layer builds on the rows above it. Adapters and the engine both use ports, the interfaces through which the engine reads and writes. <!-- code: .oxlintrc.json src/run/execute.ts#Services src/services.ts#makeProductionLayers -->

| Layer | Files under `src/` | Import boundary |
| --- | --- | --- |
| Values | `types`, `event`, `proposal`, `result`, `meta`, `plugin`, `actions`, `owner`, `hash`, `read`, `stats`, `prices`, `files`, `auths`, `cli`, `retired` | Other values. |
| Logic | `workflow`, `folder`, `context`, `graph`, `trace`, `results`, `settings` | Values and other logic. |
| Libraries | `git`, `env`, `disk` | Libraries and the rows above. |
| Ports | `tracker`, `store`, `labels`, `session`, `sandbox`, `tools` | Ports and the rows above. |
| Adapters | `github`, `docker`, `mirror`, `remote`, `harnesses`, `trackers`, `runners` | Adapters and the rows above. |
| Engine | `run/*` | Engine files, ports and the rows above ports. |
| Composition | `services`, `main`, `instance`, `status`, `engine` | All layers. |

<!-- code: .oxlintrc.json src/services.ts#makeProductionLayers -->

The import bans name specific paths. None lists `engine.ts`, `trackers.ts`, `labels.ts`, `tools.ts`, `results.ts` or `settings.ts` as a forbidden target, and the overrides for `git.ts` and `trace.ts` omit `sandbox.ts`. For these gaps the table is a convention backed only by `import/no-cycle`. <!-- code: .oxlintrc.json src/plugin.ts src/git.ts src/trace.ts -->

Across the clone, Bench and Tune normally import engine code directly. Narrow lint exceptions allow their driver files to import named CLI tools. The studio's client/server boundary uses `actions.ts`, `engine.ts` and the served instance host. <!-- code: .oxlintrc.json src/run/execute.ts#Services src/services.ts#makeProductionLayers tests/world.ts#services studio/served.ts#readInstanceServed src/actions.ts#Actions -->

## Files in src

| File | What it owns |
| --- | --- |
| `types.ts` | Run, outcome, trace, check, command and session shapes, service errors and the instance host reader. |
| `event.ts` | Issues, comments, timeline events, proposal receipts, agent requests, run marks and status headers. |
| `proposal.ts` | The applied proposal schema, reply schema and grantable kinds. |
| `result.ts` | Result schemas, validation and the judge's result server. |
| `meta.ts` | Public plugin metadata on runs. |
| `plugin.ts` | Plugin declarations, tool definitions and plugin loading. |
| `actions.ts` | The typed RPC group for studio and CLI actions. |
| `owner.ts` | Lock files, process heartbeats and machine-wide state paths. |
| `hash.ts`, `read.ts`, `stats.ts` | Content hashes, file read helpers and numeric summaries. |
| `prices.ts`, `files.ts` | Model prices and session upload handles, respectively. |
| `auths.ts`, `cli.ts`, `retired.ts` | Built-in studio auth plugins, CLI usage and flags, and the vocabulary checks. |
| `workflow.ts` | Workflow file schema and compiler, state transitions, commands and event rules. |
| `folder.ts` | Graph settings, graph loading and limits. |
| `settings.ts` | Instance file schema and setting precedence. |
| `context.ts` | Prompts, issue context, status text and redaction. |
| `graph.ts`, `trace.ts`, `results.ts` | The drawn workflow, trace and spend helpers, and the results sheet. |
| `git.ts` | Host git commands, commits and ref updates. |
| `env.ts`, `disk.ts` | Dependency environments, volumes and checkout paths, plus disk inventory, cleanup and pins. |
| `tracker.ts` | The tracker service and folder implementation. |
| `store.ts`, `labels.ts` | The file store and its service, plus run labels. |
| `session.ts`, `sandbox.ts` | The session interface and the sandbox, runner and box interfaces. |
| `tools.ts` | The server exposing plugin tools to a session. |
| `github.ts` | The GitHub tracker. |
| `mirror.ts` | The sandbox checkout over a git mirror. |
| `docker.ts`, `remote.ts` | The local Docker runner and remote box runner. |
| `harnesses.ts` | Harness configuration and the session adapter. |
| `trackers.ts`, `runners.ts` | Public entry points for built-in tracker and runner plugins. |
| `run/trigger.ts` | Scans, ticks and CLI instructions. |
| `run/start.ts` | Run creation, issue filing and forwarded messages. |
| `run/hear.ts` | Event interpretation, hooks, routing and feedback workflows. |
| `run/drive.ts`, `run/attempt.ts` | The drive loop and one try of a step. |
| `run/execute.ts` | Shell commands, sessions, judges and work queues. |
| `run/check.ts`, `run/checkout.ts` | Step checks, checkout setup, diffs and item lists. |
| `run/evaluate.ts` | Execution of end checks and later evaluations. |
| `run/settle.ts` | Recoverable proposal writes, end-check scheduling and status. |
| `run/follow.ts` | Base moves, catch-up checks and side sessions. |
| `services.ts`, `main.ts` | Environment settings and production layers, plus environment files and engine startup. |
| `instance.ts` | Instances on disk and CLI-side tracker writes. |
| `status.ts`, `engine.ts` | CLI output, instance and engine hosts, and action handlers. |

<!-- code: src/types.ts#Run src/plugin.ts#makePlugin src/workflow.ts#compileWorkflow src/folder.ts#loadGraph src/git.ts#hostGit src/env.ts#getCheckoutPaths src/store.ts#fileStore src/tracker.ts#folderTracker src/github.ts#githubTracker src/mirror.ts#makeSandbox src/docker.ts#dockerRunner src/remote.ts#boxRunner src/harnesses.ts#harnessSession src/run/trigger.ts#tick src/run/drive.ts#runWorkflow src/run/attempt.ts#runAttempt src/run/check.ts#runStepChecks src/run/settle.ts#writeProposals src/run/follow.ts#runCatchUp src/run/hear.ts#readHeard src/run/start.ts#startRun src/run/execute.ts#runSession src/run/evaluate.ts#runEndedChecks src/run/checkout.ts#runSetup src/services.ts#settings src/main.ts#start src/instance.ts#ensureInstance src/engine.ts#makeEngineHost src/status.ts#formatNextSteps -->

## bin, studio and tests

| Path | Where to look |
| --- | --- |
| `bin/run.ts` | CLI execution and loop lifecycle. |
| `bin/bench.ts`, `bin/tune.ts` | Bench workflows and Tune proposals. |
| `bin/env.ts`, `bin/setup-app.ts` | Environment inventory and cleanup, and GitHub App setup. |
| `bin/lsp.ts`, `bin/leak-probe.ts` | TypeScript reference lookup and renames, and the probe for exposed secrets. |
| `bin/results.ts` | Results-sheet data for the studio. |
| `bin/refs.mjs`, `bin/commands.mjs` | Docs anchor and name coverage checks, and documented command validation. |
| `bin/fields.mjs`, `bin/style.mjs` | Unused schema field detection, and naming and comment rules. |
| `bin/diagrams.mjs`, `bin/merge-grants.mjs` | Diagram alignment and checks for merge grants in examples. |
| `bin/commit-msg.mjs`, `bin/check.sh`, `bin/precommit.sh` | Commit message validation, the full branch check and checks on a working change. |
| `bin/hooks/` | `npm run hooks` activates `pre-commit` for static checks and `commit-msg` for the commit message. |
| `bin/style-baseline.txt` | Lists the existing style violations allowed by lint. |
| `bin/resume.ts` | Provides locks, service availability checks and child process handling for Bench and Tune. |
| `bin/traces.mjs` | Audits run traces for missing records, denied tools and missing proposal receipts. |
| `bin/usage.mjs` | Reads command names and flags from CLI source for the docs checker. |
| `bin/markdown.ts` | Finds headings and fenced code blocks for docs checks. |
| `bin/pins.mjs` | Checks and updates package version pins in the local Dockerfiles. |
| `bin/overnight.sh` | Runs queued commands in order and records successes so an interrupted queue can resume. |
| `studio/dev.ts`, `studio/watch.ts` | Vite startup and restarts when engine sources change. |
| `studio/served.ts`, `studio/auth.ts`, `studio/plugins.ts` | Instance hosts and watches, request authentication and page plugins. |
| `studio/fixtures.ts`, `studio/vite.config.ts` | The dev API and Vite configuration. |
| `studio/src/App.tsx`, `studio/src/state.ts` | Browser routes and data access. |
| `studio/src/graph/`, `runs/`, `results/`, `docs/` | Browser views for graphs, runs, results and documentation. |
| `tests/doubles/` | Service replacements and local servers used as test doubles. |
| `tests/kit.ts`, `tests/world.ts` | Shared helpers and the engine test environment. |
| `tests/fixtures.ts`, `tests/fixtures/`, `tests/setup/` | Fixture builders, on-disk test inputs and Vitest setup. |
| `tests/tick-fixtures.ts`, `tests/base-moved-fixtures.ts`, `tests/docker-fixtures.ts`, `tests/tracker-cli-fixtures.ts`, `tests/studio.ts` | Set up ticks, branch moves, Docker, tracker commands and studio tests. |

<!-- code: package.json bin/hooks/pre-commit bin/hooks/commit-msg bin/style-baseline.txt bin/resume.ts bin/traces.mjs bin/usage.mjs bin/markdown.ts bin/pins.mjs bin/overnight.sh tests/tick-fixtures.ts tests/base-moved-fixtures.ts tests/docker-fixtures.ts tests/tracker-cli-fixtures.ts tests/studio.ts bin/run.ts bin/bench.ts bin/tune.ts bin/env.ts bin/setup-app.ts bin/lsp.ts bin/leak-probe.ts bin/results.ts bin/refs.mjs bin/commands.mjs bin/fields.mjs bin/style.mjs#verbs bin/diagrams.mjs bin/merge-grants.mjs bin/commit-msg.mjs bin/check.sh bin/precommit.sh studio/served.ts#readInstanceServed studio/src/App.tsx tests/world.ts#world tests/doubles/sandbox.ts#hostSandbox tests/doubles/session.ts#replaySession -->
