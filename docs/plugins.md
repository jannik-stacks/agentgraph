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
        (await ctx.tracker.searchIssues(query, { limit: 10 })).map(({ number, title, url, body }) => ({
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
`execute` receives typed input and a context with `repo`, read-only `tracker.searchIssues`,
`abortSignal` and its own `settings`. Search stays within this repo and applies the tracker's text trust rules.
`readFile(ref)` returns fresh image bytes and their PNG or JPEG media type from a session handle.
Save images in sandbox `/tmp`, run `agi file put <path>`, then pass the handles to a tool.
The host opens no agent-supplied path. Handles expire at session close; unknown and cross-session
handles fail. Uploads are acknowledged only after raw bytes are saved at `data/files/<sha256>`
with a synced temporary file and atomic rename, and the trace is synced. Put/read traces contain
handle, size, type, hash and the trace session key. Closing a session drops its handles, while durable
bytes remain available to the store by hash. Durable reads reject a hash mismatch.
<!-- code: src/files.ts#makeFiles src/store.ts#fileStore src/tools.ts#startTools -->
Binary uploads reuse session authentication and relay with a separate route: 10 MiB per file,
32 files, 64 MiB retained, 256 MiB cumulative input and two concurrent uploads per session.
Chunk counts enforce limits regardless of Content-Length. PNG/JPEG magic bytes are checked;
no host image parser runs. Isolated decoding and re-encoding remain a later option.
Host plugins still run as trusted code.
<!-- code: src/plugin.ts#ToolContext src/folder.ts#loadGraph src/tracker.ts#parseIssueSearch -->

Plugin names may contain letters, digits, underscores and hyphens, starting with a letter.
A plugin can declare `settingsSchema`; it decodes only `plugins.<name>` in `settings.yaml`.
Bind its type once with `makePlugin<typeof settings.Type>({ name, settingsSchema: settings, tools: { ... } })`;
handlers then infer `ctx.settings`. Without a schema, that plugin's settings must be absent.
Unknown settings, duplicate plugin or tool names and symlink entries fail `check`.
<!-- code: src/plugin.ts#makePlugin src/folder.ts#SettingsFile src/plugin.ts#readPlugins -->

Imports run on the host during `check`. Review them as host code: the context supplies no tracker writes
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

## Status hooks

A plugin can declare `on.status` instead of, or next to, tools. The engine calls it after it changes an issue's
[status label](workflows.md#status-on-the-issue), with `{ issue, repo, from, to }`; `from` is absent on the first label.
The context holds `repo`, the plugin's `settings`, `tracker.searchIssues` and, on GitHub, `tracker.graphql(query, variables)`,
which sends with the project token. Hooks run in filename order. A hook that throws is logged and the run goes on.
<!-- code: src/plugin.ts#StatusChange src/plugin.ts#HookContext src/engine.ts#announce src/tracker.ts#Tracker -->

```ts
export default makePlugin({
  name: 'notify',
  on: { status: async ({ issue, to }) => { if (to.startsWith('needs')) await fetch(/* ... */) } },
});
```

`examples/board/plugins/board.ts` uses it to move the issue's card on a GitHub project board.
<!-- code: examples/board/plugins/board.ts -->

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

The header lists Inbox, Graph and Runs, then every page plugin, then Docs.

Results and Bench are built-in plugins using this same descriptor, data endpoint and hook. They keep
`/results` and `/bench` and need no graph-local file. The `results` plugin name is reserved; `bench` is
taken when the studio starts with bench dirs (`npm run dev -- --bench <dirs>`), and the Bench page is
only registered then ([Bench](bench.md#cost-against-quality)). Its snapshot keeps each
source's sheet and candidate details separate. Failed sources show an error while other sources stay
readable. It watches the selected data, bench and tune roots; bench roots only feed Exports.
It remains available when the graph cannot load; the Graph page still shows configuration problems.
<!-- code: studio/src/results/data.ts#ResultsData studio/src/results/ResultsPage.tsx#ResultsPage studio/src/bench/data.ts#BenchData -->
