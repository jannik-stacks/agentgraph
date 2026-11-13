# Extending agentgraph

Graphs configure workflows; harnesses, providers and plugins extend how they run.

## Trackers

A tracker reads issues and applies writes. Two ship as built-in plugins: `github` uses a GitHub App, and `folder` keeps issues in a local folder. A plugin with a `tracker` member adds another; see [Trackers](plugins.md#trackers). <!-- code: src/tracker.ts#Tracker src/services.ts#makeTrackerSetup src/main.ts#start -->

## Harnesses

Claude Code, Codex, opencode and pi ship as harnesses. In `agentgraph.config.ts`, add or replace entries in `harnesses`. Each supplies a command and output parser, and can check tool settings. A harness whose usage reports total the whole session, resumes included, sets `cumulative`. Set `AGENTGRAPH_CONFIG` to load your own config file. See [Harnesses](sandbox.md#harnesses). <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

## Providers

Claude and ChatGPT subscriptions, Anthropic keys and LiteLLM ship as providers. Add or replace entries in the config's `providers` list. Each names its harnesses, checks whether it is ready, and can supply settings and login. See [Providers](sandbox.md#providers). <!-- code: src/harnesses.ts#Provider harnesses/providers.ts#makeProviders -->

## Graphs

The package ships a starter example; the clone has [more example graphs](../README.md#examples). [Copy one](local.md#first-run) and edit its workflows, agents, skills and checks. The engine requires you to choose a graph. These are plain files; see [The graph folder](reference.md). <!-- code: src/instance.ts#ensureGraph -->

## Plugins

Reviewed TypeScript files in the graph's `plugins/` folder export `makePlugin(...)`. A plugin can supply agent tools, status hooks, a tracker, a runner, studio auth or a studio page. Its `settingsSchema` decodes `plugins.<name>` in `settings.yaml`. See [Plugins](plugins.md) for each member's interface.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/plugin.ts#StatusChange src/plugin.ts#TrackerHost src/plugin.ts#RunnerHost src/plugin.ts#AuthHost -->

Plugins run as trusted host code. Studio readers get instance hosts for run and tracker reads; browser actions require studio authorization.
<!-- code: src/engine.ts#makeInstanceHost src/actions.ts#Actions -->

The engine's built-in [triggers](workflows.md#what-starts-a-run) and [proposal kinds](proposals.md#kinds) define what workflows can use.

## Bench

[Bench](bench.md) replays merged changes and compares agents. Its runner and scorer live in the engine clone at `bin/bench.ts` and `bench/`. The studio page is an example plugin in `examples/plugins/bench`, loaded with `agi studio --plugins examples/plugins/bench`. <!-- code: examples/plugins/bench/plugins/bench.ts bench/runs.ts#readBenchData bin/bench.ts#runArm -->

## Tune

Tune is an experimental clone-only tool that tests graph changes through Bench, with little test coverage and unstable commands and files. Submit a candidate with `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`.
