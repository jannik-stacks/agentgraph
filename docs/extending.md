# Extending agentgraph

Start with the parts that ship, then change the ones your repo needs.

## Trackers

A tracker reads issues and applies writes. Two ship as built-in plugins: `github` uses a GitHub App, and `folder` keeps issues in a local folder. A plugin with a `tracker` member adds another; see [Trackers](plugins.md#trackers). <!-- code: src/tracker.ts#Tracker src/services.ts#makeTrackerSetup src/main.ts#start -->

## Harnesses

Claude Code, Codex, opencode and pi ship as harnesses. In `agentgraph.config.ts`, add or replace entries in `harnesses`. Each supplies a command and output parser, and can check tool settings. Set `AGENTGRAPH_CONFIG` to load your own config file. See [Harnesses](sandbox.md#harnesses). <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

## Providers

Claude and ChatGPT subscriptions, Anthropic keys and LiteLLM ship as providers. Add or replace entries in the config's `providers` list. Each names its harnesses, checks whether it is ready, and can supply settings and login. See [Providers](sandbox.md#providers). <!-- code: src/harnesses.ts#Provider harnesses/providers.ts#makeProviders -->

## Graphs

The package ships a starter example; the clone has [more example graphs](../README.md#examples). [Copy one](local.md#first-run) and edit its workflows, agents, skills and checks. The engine requires you to choose a graph. These are plain files; see [The graph folder](reference.md). <!-- code: src/instance.ts#ensureGraph -->

## Plugins

Reviewed TypeScript files in the graph's `plugins/` folder export `makePlugin(...)`. A plugin can supply agent tools, status hooks, a tracker, a runner, studio auth or a studio page. Its `settingsSchema` decodes `plugins.<name>` in `settings.yaml`. See [Plugins](plugins.md) for each member's interface.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/plugin.ts#StatusChange src/plugin.ts#TrackerHost src/plugin.ts#RunnerHost src/plugin.ts#AuthHost -->

Plugin code runs on the host and needs review. The engine keeps trust, checks and write permissions. Studio page readers receive the instance host for runs and tracker reads. Pages can post local comments and set run labels through the host's typed actions. Opening a page starts no work.
<!-- code: src/engine.ts#makeInstanceHost studio/src/plugins.ts#runAction -->

The engine's built-in [triggers](workflows.md#what-starts-a-run) and [proposal kinds](proposals.md#kinds) define what workflows can use.

## Bench

[Bench](bench.md) replays merged changes and compares agents. It runs from the clone, with a CLI and a built-in studio page plugin. Add cases and choose graphs and model settings for a comparison. <!-- code: studio/src/bench/plugin.ts#readBenchData bin/bench.ts#runArm -->

## Tune

Tune proposes graph changes, tests them through Bench and keeps the ones that improve results. It runs from the clone. Edit a graph and submit it with `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`. Tune uses Bench to evaluate candidates. Workflows run without either tool.
