# Plugins

Write a reviewed TypeScript file in the graph's `plugins/` folder. A plugin can supply agent tools, status hooks, a tracker, a runner, studio auth or a studio page.
For agent tools, Effect Schema types and validates the input; `tool` delegates to the AI SDK.
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

Unknown tool names fail graph validation. `execute` receives typed input, an abort signal, plugin settings and repository-scoped tracker search. `settingsSchema` decodes `plugins.<name>`; unknown settings, duplicate names and symlink entries fail validation.

Plugins run on the host during validation and execution, with access to its files, environment and network. Review their code. Shipped examples reserve merging for humans; the engine itself allows `merge` when the step grants it.

The engine supplies its own Effect, AI SDK and public plugin, tracker and runner entries. Other dependencies resolve from the graph. Helpers belong under plugin subfolders and contribute to the graph hash. Plugin declarations reload on loop passes; restart for runner or imported-helper changes.

Each session gets an authenticated MCP endpoint for its selected tools. Calls and redacted results appear in the trace. The `box` runner refuses host tools. Credentials stay on the host unless explicitly forwarded as model login variables.

For image input, save a PNG or JPEG in sandbox `/tmp`, run `agi file put <path>`, and pass the returned handle to a tool. `ctx.readFile(ref)` consumes it once; unknown, consumed or cross-session handles fail. Uploads are limited to 10 MiB each, 32 unread handles, 64 MiB held and 256 MiB total per session. Bytes persist by hash under `data/files/`; unread handles expire when the session closes.

<!-- code: src/plugin.ts#ToolContext src/folder.ts#loadGraph src/tracker.ts#parseIssueSearch src/files.ts#makeFiles src/store.ts#fileStore src/tools.ts#startTools --> <!-- code: src/files.ts#makeFiles src/tools.ts#startTools --> <!-- code: src/plugin.ts#makePlugin src/folder.ts#GraphSettings src/plugin.ts#readPlugins --> <!-- code: bin/merge-grants.mjs --> <!-- code: bin/run.ts#serve studio/plugins.ts#makeStudioPagesPlugin --> <!-- code: src/plugin.ts#readPlugins --> <!-- code: src/tools.ts#startTools src/harnesses.ts#harnessSession src/remote.ts#whyBoxRefused src/services.ts#whyRunnerRefuses bin/run.ts#loadServedGraph --> <!-- code: src/docker.ts#dockerRunner src/docker.ts#dockerArgs --> <!-- code: src/tools.ts#startTools -->

## Status hooks

`on.status` receives `{ issue, repo, from, to }` after an issue's status changes. Its context supplies plugin settings, tracker search and, on GitHub, `tracker.writeField(issue, { project, field, value })`. A null value clears a project field; writing needs a token with `project` scope.

Hooks run in filename order; a thrown error is logged without stopping the run. A [board plugin](../tests/fixtures/triggers/plugins/board.ts) maps statuses to project fields. <!-- code: src/plugin.ts#StatusChange src/plugin.ts#HookContext src/run/settle.ts#announce src/tracker.ts#Tracker --> <!-- code: tests/fixtures/triggers/plugins/board.ts#settings src/plugin.ts#HookContext -->

## Trackers

A plugin's `tracker` receives `{ repo, studio, app, dir }` and returns `layer(trust)`, providing `Tracker`, plus `origin`, the git remote to mirror. Optional `status(n, to, names)` displays the graph's status names.

Select it with `--tracker`, an instance record or environment settings; see [precedence](local.md#named-instances-and-settings). A plugin name selects that tracker; another value names a folder for the built-in folder tracker. Only plugins in a graph read by the host can select a tracker. Unknown or incompatible selections fail `agi check`. <!-- code: src/plugin.ts#TrackerHost src/services.ts#readHostSettings src/services.ts#pickTracker src/tracker.ts#folder src/github.ts#github src/run/settle.ts#writeStatus -->

### Your own tracker

Import `folder` or `github` from `@jannik-stacks/agi/trackers` to wrap a built-in. [my-folder.ts](../examples/plugins/trackers/my-folder.ts) adds a trusted login; copy it into your graph's `plugins/` and select `--tracker my-folder`.

An instance tracker must keep the supplied `origin.git`, which merge and export use. Local CLI writes still go directly to the folder. Use `status: false` to disable status display without a wrapper. <!-- code: src/plugin.ts#TrackerHost src/services.ts#pickTracker src/services.ts#makeTrackerSetup src/tracker.ts#folder src/tracker.ts#folderTracker src/trackers.ts examples/plugins/trackers/my-folder.ts -->

## Runners

A plugin's `runner` receives `RunnerHost` (`{ data, image, cache, direct }`) and settings, and returns a layer providing `Runner`. `open` starts a box for a checkout; `whyRefused` explains unsupported graph settings.

`makeBoxRunner` from `@jannik-stacks/agi/runners` takes `op` for box operations and `run` for commands. Runners must preserve read-only access and network restrictions. Select one with `--runner` or [instance settings](local.md#named-instances-and-settings); `agi check` rejects unsupported graphs. Built-ins are `local` and `box`; [Modal](../examples/plugins/modal/modal.ts) is an example plugin. <!-- code: src/plugin.ts#makePlugin src/plugin.ts#RunnerHost src/sandbox.ts#Runner src/services.ts#pickRunner src/runners.ts#local src/runners.ts#box src/remote.ts#makeBoxRunner src/services.ts#whyRunnerRefuses examples/plugins/modal/modal.ts#makeModalRunner -->

## Auth

A plugin's `auth` receives host environment and settings, then checks each request's URL, headers and login form. It returns `{ kind: 'user', user }`, `{ kind: 'login', url }` or `{ kind: 'refuse', why }`. Every studio page, API, action and live connection passes this gate.

Select with `npm run dev -- --auth <name>`, instance env, host graph `auth`, shell `AGENTGRAPH_AUTH`, then default `token`. Repository graphs cannot select auth; served instances must agree on auth and settings.

| Mode                      | Login                                          |
| ------------------------- | ---------------------------------------------- |
| `token`                   | Random token and printed login URL             |
| `password`                | `AGENTGRAPH_STUDIO_PASSWORD`                   |
| `none`                    | No login; explicitly selected                  |
| Cloudflare Access example | Signed Access header and allowed email domains |

Copy [cloudflare-access.ts](../examples/plugins/cloudflare-access.ts) into the host graph to use that example:

```yaml
auth: cloudflare-access
plugins:
  cloudflare-access:
    team: https://myteam.cloudflareaccess.com
    audience: <the Access application's AUD tag>
    domains: [example.com]
```

`AGENTGRAPH_STUDIO_TOKEN` fixes the login token; `AGENTGRAPH_STUDIO_KEY` sets a signing secret of at least 32 characters. `AGENTGRAPH_STUDIO_API_TOKEN` allows bearer-authenticated scripts when the plugin requests login. Instance env files override the shell.

Login sessions use signed cookies for the host and port, lasting an hour and renewing for up to twelve hours. Changing signing inputs invalidates them. The gate rejects cross-site writes and live connections; `POST /auth/logout` ends a session. `AGI_HOST` selects the listen address and `AGI_ALLOWED_HOSTS` lists allowed hostnames. <!-- code: src/plugin.ts#AuthHost src/plugin.ts#AuthRequest src/plugin.ts#AuthResult src/services.ts#pickAuth studio/auth.ts#readStudioAuth studio/auth.ts#makeStudioAuthPlugin --> <!-- code: src/auths.ts#token src/auths.ts#password src/auths.ts#none examples/plugins/cloudflare-access.ts#settings --> <!-- code: studio/auth.ts#readStudioAuth studio/auth.ts#makeStudioAuthPlugin src/auths.ts#isSameSecret studio/vite.config.ts#server -->

## Studio pages

A plugin's `studio` declares a title, local TSX page URL, data schema and `read(settings, hosts)` effect. Optional `watch(settings, hosts)` returns folders whose changes refresh the page. `InstanceHosts` maps instance names to read hosts or `{ why }` for failed instances. Hosts provide run data, latest checks and tracker reads.

An instance graph plugin receives only its instance. A folder selected with `agi studio --plugins <dir>` receives all served instances; it contains `plugins/` and a `settings.yaml`. `AGENTGRAPH_STUDIO_PLUGINS` also selects that folder. These pages live at `/plugins/<name>`, with a header link to Runs across instances; named instance pages live at `/<instance>/plugins/<name>`.

The TSX file default-exports a React component. Set `page: new URL('./Page.tsx', import.meta.url)` and call `usePluginData` from `@jannik-stacks/agi/studio` with the plugin name and shared browser-safe schema. That entry also exports studio UI, navigation and result components.

Studio actions share the CLI's typed RPC interface, but browser users may only read, post comments and set labels. Other actions require the CLI; stores opened through `?data=` are read-only. Pages share the studio's origin and API authority, so review them as trusted code.

Readers serve snapshots at `/api/plugins/<name>/data`, capped at 16 MiB. The live connection refreshes watched data; a failed refresh keeps the previous snapshot and shows an error. Host readers and settings stay outside the browser manifest. Graph changes reload declarations; imported helper changes need a restart.

The [dashboard example](../examples/dashboard/README.md) provides configurable widgets. [Bench](../examples/plugins/bench/README.md) is an example plugin loaded with `--plugins`. The built-in Results page uses the same descriptor and data hook at `/results`, even when the graph fails to load. <!-- code: studio/plugins.ts#readFolderPages studio/plugins.ts#readHosts studio/dev.ts src/types.ts#InstanceHosts --> <!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/types.ts#InstanceHost src/engine.ts#makeInstanceHost --> <!-- code: studio/src/plugins.ts#usePluginData studio/plugins.ts#makeStudioPagesPlugin studio/src/ui.tsx#Live studio/src/ui.tsx#Badge studio/src/ui.tsx#Disclosure studio/src/ui.tsx#Tooltip studio/src/state.ts#queryParam studio/src/state.ts#navigateAtom studio/src/results/ResultTable.tsx#ResultTable studio/src/plugins.ts#ResultChart --> <!-- code: src/actions.ts#Actions src/engine.ts#makeActionWebHandler src/engine.ts#runLocalActions studio/fixtures.ts#makeStudioDevApiPlugin studio/src/state.ts#runAction --> <!-- code: studio/src/plugins.ts#usePluginData studio/plugins.ts#makeStudioPagesPlugin --> <!-- code: studio/plugins.ts#makeStudioPagesPlugin studio/plugins.ts#readStudioPages studio/plugins.ts#readWatchRoots --> <!-- code: studio/src/App.tsx#official studio/src/App.tsx#custom --> <!-- code: examples/dashboard/plugins/dashboard.ts examples/dashboard/plugins/dashboard/data.ts#DashboardSettings examples/dashboard/plugins/dashboard/data.ts#sources examples/dashboard/plugins/dashboard/read.ts#readDashboard --> <!-- code: studio/plugins.ts#makeResultsPlugin studio/src/results/data.ts#ResultsData studio/src/results/ResultsPage.tsx#ResultsPage examples/plugins/bench/plugins/bench.ts -->

## Engine access

`makeEngineHost(plugin, configs)` lists allowed stores, reads runs with labels and latest checks, and submits started or imported runs. Submission validates labels and stamps the origin with the plugin's name.

The clone's `bin/bench.ts` creates a submitting host. The example Bench studio plugin creates a read-only host from the instances it receives. <!-- code: src/engine.ts#EngineHost src/engine.ts#Submission src/engine.ts#makeEngineHost bench/runs.ts#makeSetHost -->
