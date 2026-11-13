# Plugins

TypeScript files in the graph's `plugins/` folder supply tools, hooks, trackers, runners, auth or pages. Effect Schema validates tool inputs; `tool` delegates to the AI SDK.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/plugin.ts#tool -->

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
          number,
          title,
          url,
          body: body.slice(0, 500),
        })),
    }),
  },
});
```

Select it in `agents/triager.md`:

```yaml
tools: [read, grep, glob, issues]
```

`execute` receives input, an abort signal, settings and tracker search. `settingsSchema` decodes `plugins.<name>`. Unknown tools or settings, duplicate names and symlinks fail validation.
<!-- code: src/plugin.ts#ToolContext src/folder.ts#loadGraph src/plugin.ts#makePlugin src/folder.ts#GraphSettings src/plugin.ts#readPlugins -->

Review plugins before use. They can access host files, environment and network during validation and execution. The engine supplies Effect, AI SDK and public plugin, tracker and runner entries. Other dependencies resolve from the graph. Helpers in subfolders affect the graph hash. Declarations reload each loop pass; runner or imported-helper changes need a restart.
<!-- code: src/plugin.ts#readPlugins bin/run.ts#serve studio/plugins.ts#makeStudioPagesPlugin -->

Each session gets an authenticated MCP endpoint for its selected tools. Calls and redacted results enter traces. See [transport and credentials](sandbox.md#secrets-on-the-host).
<!-- code: src/tools.ts#startTools -->

Save a PNG or JPEG in sandbox `/tmp`, run `agi file put <path>`, and pass the returned handle to a tool. `ctx.readFile(ref)` consumes it once. Unknown, consumed or cross-session handles fail. Each upload is limited to 10 MiB. A session allows 32 unread handles, 64 MiB held and 256 MiB total. Bytes persist by hash in `data/files/`; unread handles expire at session close. The `box` runner refuses host tools.
<!-- code: src/files.ts#makeFiles src/store.ts#fileStore src/tools.ts#startTools src/remote.ts#whyBoxRefused -->

## Status hooks

`on.status` receives `{ issue, repo, from, to }` after a status change. Its context supplies settings and tracker search. On GitHub, `tracker.writeField(issue, { project, field, value })` needs `project` scope; `null` clears the field. Hooks run in filename order. Errors are logged without stopping the run. See the [board example](../tests/fixtures/triggers/plugins/board.ts).
<!-- code: src/plugin.ts#StatusChange src/plugin.ts#HookContext src/run/settle.ts#announce src/tracker.ts#Tracker tests/fixtures/triggers/plugins/board.ts#settings -->

## Trackers

`tracker({ repo, studio, app, dir })` returns `layer(trust)`, which provides `Tracker`, plus the git remote `origin`. Optional `status(n, to, names)` displays status names. `searchIssues` searches only the repository and applies text trust rules.
<!-- code: src/tracker.ts#Tracker src/tracker.ts#parseIssueSearch src/tracker.ts#folderTracker src/github.ts#githubTracker -->

Select a plugin name or built-in tracker folder with `--tracker` or [instance and environment settings](local.md#named-instances-and-settings). Tracker plugins require a graph read by the host. Unknown or incompatible selections fail `agi check`.
<!-- code: src/plugin.ts#TrackerHost src/services.ts#readHostSettings src/services.ts#pickTracker src/tracker.ts#folder src/github.ts#github src/run/settle.ts#writeStatus -->

### Your own tracker

Wrap `folder` or `github` from `@jannik-stacks/agi/trackers`; see the [example](../examples/plugins/trackers/my-folder.ts). Preserve the instance's supplied `origin.git` for merge and export. Local CLI writes go directly to the folder. `status: false` disables status display.
<!-- code: src/plugin.ts#TrackerHost src/services.ts#pickTracker src/services.ts#makeTrackerSetup src/tracker.ts#folder src/tracker.ts#folderTracker src/trackers.ts examples/plugins/trackers/my-folder.ts -->

## Runners

`runner` receives `RunnerHost` (`{ data, image, cache, direct }`) and settings, then returns a `Runner` layer. `open` starts a box for a checkout; `whyRefused` explains unsupported settings. `@jannik-stacks/agi/runners` exports `makeBoxRunner({ op, run })`: `op` handles box operations and `run` executes commands. Preserve read-only access and network restrictions. See [runner selection and validation](sandbox.md#runners) and [Modal](../examples/plugins/modal/modal.ts).
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#RunnerHost src/sandbox.ts#Runner src/services.ts#pickRunner src/runners.ts#local src/runners.ts#box src/remote.ts#makeBoxRunner src/services.ts#whyRunnerRefuses examples/plugins/modal/modal.ts#makeModalRunner -->

## Auth

`auth` receives the host environment and settings, then checks each request's URL, headers and login form. It returns `{ kind: 'user', user }`, `{ kind: 'login', url }` or `{ kind: 'refuse', why }`. Every studio page, API, action and live connection passes this gate.
<!-- code: src/plugin.ts#AuthHost src/plugin.ts#AuthRequest src/plugin.ts#AuthResult -->

Auth selection uses the first value: `npm run dev -- --auth <name>`, instance env, host graph `auth`, shell `AGENTGRAPH_AUTH`, then `token`. Repository graphs cannot select auth. Served instances must agree on auth and settings.
<!-- code: src/services.ts#pickAuth -->

`token` generates a random token and prints a login URL. `AGENTGRAPH_STUDIO_TOKEN` sets a fixed token. `password` uses `AGENTGRAPH_STUDIO_PASSWORD`; explicitly selected `none` skips login. The [Cloudflare Access example](../examples/plugins/cloudflare-access.ts) checks signed headers and allowed email domains.
<!-- code: src/auths.ts#token src/auths.ts#password src/auths.ts#none examples/plugins/cloudflare-access.ts#settings -->

`AGENTGRAPH_STUDIO_KEY` sets a signing secret of at least 32 characters. `AGENTGRAPH_STUDIO_API_TOKEN` allows bearer access when the plugin requests login. Instance env overrides the shell. Signed cookies apply to the host and port, last one hour and renew for up to twelve hours. Changed signing inputs invalidate them. `POST /auth/logout` ends a session. Cross-site writes and live connections are rejected. `AGI_HOST` sets the listen address; `AGI_ALLOWED_HOSTS` lists allowed hostnames.
<!-- code: studio/auth.ts#readStudioAuth studio/auth.ts#makeStudioAuthPlugin src/auths.ts#isSameSecret studio/vite.config.ts#server -->

## Studio pages

`studio` declares a title, local TSX page URL, data schema and `read(settings, hosts)` effect. Optional `watch(settings, hosts)` returns folders to watch. `InstanceHosts` maps instance names to hosts that read runs, checks and tracker data, or `{ why }` for failures. Default-export a React component and set `page: new URL('./Page.tsx', import.meta.url)`. Call `usePluginData` from `@jannik-stacks/agi/studio` with the plugin name and shared browser-safe schema.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/types.ts#InstanceHosts src/types.ts#InstanceHost src/engine.ts#makeInstanceHost studio/src/plugins.ts#usePluginData -->

Graph plugins receive only their instance; pages live at `/<instance>/plugins/<name>`. `agi studio --plugins <dir>` or `AGENTGRAPH_STUDIO_PLUGINS` selects a folder containing `plugins/` and `settings.yaml`. Its pages receive all served instances and live at `/plugins/<name>`, with a link to Runs.
<!-- code: studio/plugins.ts#readFolderPages studio/plugins.ts#readHosts studio/dev.ts studio/src/App.tsx#official studio/src/App.tsx#custom -->

Review pages as trusted code: they share the studio's origin and API authority. Browser users may read, post comments and set labels through typed RPC. Other actions require the CLI. Stores opened through `?data=` are read-only.
<!-- code: src/actions.ts#Actions src/engine.ts#makeActionWebHandler src/engine.ts#runLocalActions studio/fixtures.ts#makeStudioDevApiPlugin studio/src/state.ts#runAction -->

`/api/plugins/<name>/data` serves snapshots capped at 16 MiB. Watched changes refresh the page. A failed refresh keeps the previous snapshot and shows an error. Readers and settings stay server-side. See [reload rules](#plugins).
<!-- code: studio/plugins.ts#makeStudioPagesPlugin studio/plugins.ts#readStudioPages studio/plugins.ts#readWatchRoots -->

See [dashboard widgets](../examples/dashboard/README.md). [Results](checks.md#the-results-tab) uses the same descriptor and data hook at `/results`, even when the graph fails to load.
<!-- code: examples/dashboard/plugins/dashboard.ts examples/dashboard/plugins/dashboard/data.ts#DashboardSettings examples/dashboard/plugins/dashboard/data.ts#sources examples/dashboard/plugins/dashboard/read.ts#readDashboard -->

[Bench](../examples/plugins/bench/README.md) is an example plugin loaded with `--plugins`.
<!-- code: studio/plugins.ts#makeResultsPlugin studio/src/results/data.ts#ResultsData studio/src/results/ResultsPage.tsx#ResultsPage examples/plugins/bench/plugins/bench.ts -->

## Engine access

`makeEngineHost(plugin, configs)` lists allowed stores, reads runs with labels and latest checks, and submits started or imported runs. Submission validates labels and records the plugin's name in the origin.
<!-- code: src/engine.ts#EngineHost src/engine.ts#Submission src/engine.ts#makeEngineHost -->

The clone's `bin/bench.ts` creates a submitting host. The example Bench studio plugin creates a read-only host from the instances it receives. <!-- code: src/engine.ts#EngineHost src/engine.ts#Submission src/engine.ts#makeEngineHost bench/runs.ts#makeSetHost -->
