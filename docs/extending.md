# Extending agentgraph

Start with the parts that ship, then change the ones your repo needs.

## Trackers

A tracker reads issues and applies writes. The GitHub tracker uses a GitHub App; the folder tracker keeps issues in a local folder. The CLI chooses between them. From source, implement `Tracker` and pass it through `start`'s services argument. CLI registration is in progress. <!-- code: src/tracker.ts#Tracker src/services.ts#where src/main.ts#start -->

## Harnesses

Claude Code, Codex, opencode and pi ship as harnesses. In `agentgraph.config.ts`, add or replace entries in `harnesses`. Each supplies a command and output parser, and can check tool settings. Set `AGENTGRAPH_CONFIG` to load your own config file. See [Harnesses](sandbox.md#harnesses). <!-- code: src/harnesses.ts#Harness src/harnesses.ts#readHarnessSettings -->

## Providers

Claude and ChatGPT subscriptions, Anthropic keys and LiteLLM ship as providers. Add or replace entries in the config's `providers` list. Each names its harnesses, checks whether it is ready, and can supply settings and login. See [Providers](sandbox.md#providers). <!-- code: src/harnesses.ts#Provider harnesses/providers.ts#makeProviders -->

## Graphs

The package ships a starter example; the clone has [more example graphs](../README.md#examples). [Copy one](local.md#first-run) and edit its workflows, agents, skills and checks. The engine requires you to choose a graph. These are plain files; see [The graph folder](reference.md). <!-- code: src/instance.ts#ensureGraph -->

## Plugins, in progress

[Tool plugins](plugins.md) load now from the graph's `plugins/` folder. Other plugin parts are planned.
<!-- code: src/plugin.ts#readPlugins -->

The planned API extends those files. Each exports `makePlugin(...)` with only the parts it needs: tools agents can call, triggers that match events, actions that apply proposals, a tracker, or a studio page. The runner chooses the tracker; a graph cannot replace its own tracker.

This example shows the planned shape. It does not run today:

```ts
import { Schema } from 'effect';
import { makePlugin, makeTrigger } from '@jannik-stacks/agi/plugins';

export default makePlugin({
  name: 'labels',
  triggers: {
    ready: makeTrigger({
      inputSchema: Schema.String,
      match: (label, event) => event.kind === 'label' && event.label === label,
      describe: label => `When the ${label} label is added`,
    }),
  },
});
```

Plugin settings will live under `plugins.<name>` in `settings.yaml`. Plugin code runs on the host and needs review. The engine keeps trust, checks and write permissions. A studio page will pair a browser component with a read-only data reader; opening it will start no work.

## Bench

[Bench](bench.md) replays merged changes and compares agents. Today it runs from the clone. Add cases and choose graphs and model settings for a comparison. The planned Bench package will keep its own CLI and add a studio page through the plugin API.

## Tune

Tune proposes graph changes, tests them through Bench and keeps the ones that improve results. Today it runs from the clone. Edit a graph and submit it with `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`. The planned Tune package will depend on Bench and supply its own CLI and studio page. Neither package will be required to run workflows.
