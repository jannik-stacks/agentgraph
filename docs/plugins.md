# Plugins

Write a reviewed TypeScript file in `plugins/` to give an agent a tool that runs in the engine.
Effect Schema types and validates the input; `tool` delegates to the AI SDK.
<!-- code: src/plugin.ts#readPlugins src/plugin.ts#tool -->

```ts
import { makePlugin, tool } from '@jannik-stacks/agi/plugins';
import { Schema } from 'effect';

export default makePlugin({
  name: 'issues',
  tools: {
    issues: tool({
      description: 'Search issues in this repository by keywords',
      inputSchema: Schema.Struct({ query: Schema.String }),
      execute: async ({ query }, ctx) =>
        (await ctx.forge.searchIssues(query, { limit: 10 })).map(({ number, title, url, body }) => ({
          number, title, url, body: body.slice(0, 500),
        })),
    }),
  },
});
```

Select it in `agents/triager.md`:

```yaml
tools: [read, grep, glob, issues]
```

Names outside the harness's built-ins must name registered plugin tools; unknown names fail `check`.
`execute` receives typed input and a context with `repo`, read-only `forge.searchIssues`,
`abortSignal` and its own `settings`. Search stays within this repo and applies the forge's text trust rules.
<!-- code: src/plugin.ts#ToolContext src/folder.ts#loadGraph src/forge.ts#parseIssueSearch -->

A plugin can declare `settingsSchema`; it decodes only `plugins.<name>` in `settings.yaml`.
Bind its type once with `makePlugin<typeof settings.Type>({ name, settingsSchema: settings, tools: { ... } })`;
handlers then infer `ctx.settings`. Without a schema, that plugin's settings must be absent.
Unknown settings, duplicate plugin or tool names and symlink entries fail `check`.
<!-- code: src/plugin.ts#makePlugin src/folder.ts#SettingsFile src/plugin.ts#readPlugins -->

Imports run on the host during `check`. Review them as host code: the context supplies no forge writes
or engine services, but TypeScript can still read the host environment, files and network.
The engine supplies `effect`, `ai` and `@jannik-stacks/agi/plugins` from its own install, including
Effect and AI SDK subpaths, so plugins share its Effect runtime. Other packages use Node's normal
resolution from the graph. Keep local helpers in subfolders of `plugins/`; their source contributes
to the graph hash. Restart after code changes.
<!-- code: src/plugin.ts#readPlugins -->

Each session gets an MCP endpoint listing only its selected tools. Claude Code, Codex, opencode
and pi receive its URL and an environment reference to its bearer in their MCP configuration.
The pinned pi version has a built-in MCP transport.
Remote sandboxes reject host tools. Calls return through MCP and record their name, input,
result preview and duration in the run's trace.
<!-- code: src/tools.ts#startTools src/harnesses.ts#harnessSession src/remote.ts#remoteSandbox -->

The listener binds to loopback on macOS, or to the Docker bridge gateway on Linux with peer subnet
checks. A per-session relay runs as non-root with a read-only root on the sandbox networks and
forwards only that host port. It is needed because the isolated sandbox cannot reach the host
listener directly. The relay holds no bearer.
Both listener and relay close when the session ends; cancellation traces finish before closure.
<!-- code: src/docker.ts#dockerSandbox src/docker.ts#dockerArgs -->

Every request needs its unpredictable path, 256-bit bearer and matching Host header; an Origin
header must match when present. Limits are eight TCP connections, four HTTP requests and four tool
executions, a 30-second request deadline, a 64 KiB body, 16 KiB results and schemas, and
2,048-character trace previews and descriptions.
Timeout signals cancellation; reviewed JavaScript must cooperate. An execution keeps its slot
until its underlying promise settles.
Known secrets are masked before output and tracing. Plugin credentials stay on the host;
`AGENTGRAPH_SESSION_ENV` accepts only the four documented model login variables.
<!-- code: src/tools.ts#startTools -->

## Studio pages

A plugin can provide `studio` instead of tools. It declares a title, a local TSX page URL, an Effect
Schema for its data and a read-only `read(settings)` effect. Optional `watch(settings)` returns data
roots. The reader and watch receive only this plugin's decoded settings. Loading declarations does
not execute readers or import TSX. Host code remains trusted; namespaces are not isolation.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins -->

A page default-exports a React component. Set `page: new URL('./Page.tsx', import.meta.url)`;
Vite compiles it and its CSS. Import `usePluginData` from `@jannik-stacks/agi/studio` in the page.
Pass its plugin name and a browser-safe data schema shared with the host reader. The studio also
exports its UI, query/navigation atoms and results components through that browser entry.
<!-- code: studio/src/plugins.ts#usePluginData studio/plugins.ts#makeStudioPagesPlugin -->

Pages appear at `/plugins/<name>`. HTTP snapshots come from `/api/plugins/<name>/data`; one SSE
connection invalidates all mounted readers when main data or declared roots change. A failed
refresh keeps the last good data and shows an error. Snapshots are capped at 16 MiB.
Host readers, settings and data roots never enter the page manifest. Pages share the studio origin
and its API authority; review them like host plugins. Registering a page starts no job. Restart the
studio after registrations change. Preview needs a host API for live data.
