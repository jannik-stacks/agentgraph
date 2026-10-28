# Plugins

A graph loads default exports from `plugins/*.ts`. Each file names one plugin and its tools.
Use Effect Schema for input; the public `tool` helper delegates to the AI SDK.
<!-- code: src/plugin.ts#readPlugins src/plugin.ts#tool -->

```ts
import { makePlugin, tool } from '@jannik-stacks/agi/plugins';
import { Schema } from 'effect';

export default makePlugin({
  name: 'issues',
  tools: {
    issues: tool({
      description: 'Search issues in this repository',
      inputSchema: Schema.Struct({ query: Schema.String }),
      execute: ({ query }, ctx) => ctx.forge.searchIssues(query, { limit: 10 }),
    }),
  },
});
```

`execute` receives typed input and a context with `repo`, read-only `forge.searchIssues`,
`abortSignal` and its own `settings`. A plugin can declare `settingsSchema`; only its namespace
under `settings.yaml` is decoded. For example, `plugins: { issues: { limit: 10 } }` belongs to
plugin `issues`. Without a settings schema, its namespace must be absent.
<!-- code: src/plugin.ts#ToolContext src/plugin.ts#makePlugin src/folder.ts#SettingsFile -->

For settings tools, bind the decoded type once: `makePlugin<typeof settings.Type>({ name,
settingsSchema: settings, tools: { ... } })`. Nested tool handlers then infer `ctx.settings`; the matching schema is required.
Unknown namespaces and fields fail `check`, as do duplicate plugin IDs, duplicate tool names,
invalid definitions and discovery symlinks that escape the graph.

Plugin imports run on the host during `check`. Review this code before loading it and keep
credentials in the engine environment. Install dependencies where Node can resolve them from
the graph. Keep local helpers below `plugins/` in subfolders; their source is part of the graph
hash. Restart the engine after code changes so imported helpers reload.
