# Extending agentgraph

Start with the part you want to change. A graph describes work on an issue. Harnesses run agent sessions, providers supply model access, and plugins connect the engine to other services. See [Terms](index.md#terms). <!-- code: src/folder.ts#Graph src/harnesses.ts#Harness src/harnesses.ts#Provider src/plugin.ts#makePlugin -->

## Graphs

[Copy the starter](local.md#first-run) or choose an [example graph](../README.md#examples). Edit its Markdown and YAML files to change which agents run, what they can propose and how their work is checked. See [The graph folder](reference.md), [workflow triggers](workflows.md#what-starts-a-run) and [proposal kinds](proposals.md#kinds). <!-- code: src/instance.ts#ensureGraph src/folder.ts#loadGraph src/workflow.ts#Front src/proposal.ts#Kind -->

## Trackers

To connect an issue tracker, choose a [built-in tracker or supply a tracker plugin](plugins.md#trackers). <!-- code: src/services.ts#makeTrackerSetup -->

## Harnesses

Claude Code, Codex, opencode and pi ship as harnesses. A harness supplies a command and an output parser, and can check tool settings. Set `cumulative` if its usage reports cover the whole session, including resumed turns. Add your harness to the config's `harnesses` list. See [Harnesses](sandbox.md#harnesses) for config selection and `AGENTGRAPH_CONFIG`. <!-- code: agentgraph.config.ts src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

## Providers

The shipped providers support Claude and ChatGPT subscriptions, Anthropic keys and LiteLLM. To add a provider, add an entry to the config's `providers` list. It names the harnesses it supports, checks whether credentials are ready, and can supply settings and login instructions. See [Providers](sandbox.md#providers). <!-- code: harnesses/providers.ts#makeProviders src/harnesses.ts#Provider -->

## Plugins

See [Plugins](plugins.md) to add tools, status or event hooks, a tracker, a runner, studio authentication or a studio page. See [Architecture](architecture.md#the-studio) for the host interfaces behind studio pages. <!-- code: src/plugin.ts#makePlugin src/plugin.ts#EventHook src/engine.ts#makeInstanceHost -->

## Bench and Tune

Use [Bench](bench.md) to compare workflows on merged changes and [Tune](bench.md#tune) to test a candidate graph. Both tools run from a clone. <!-- code: bin/bench.ts#runArm bin/tune.ts#propose package.json -->
