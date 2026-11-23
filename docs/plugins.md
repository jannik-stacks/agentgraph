# Plugins

A plugin is a TypeScript file in the graph's `plugins/` folder. It can supply tools, hooks, a [tracker or runner](index.md#terms), studio authentication or a studio page. The `tool` helper delegates to the AI SDK and validates inputs with Effect Schema.
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

To give an agent the search tool, include it in the agent's `tools` list. <!-- code: src/types.ts#Agent src/folder.ts#loadGraph -->

```yaml
tools: [read, grep, glob, issues]
```

`execute(input, ctx)` receives the decoded input. Its context includes `repo`, `settings`, `tracker.searchIssues`, `readFile` and an optional `abortSignal`. `settingsSchema` decodes `plugins.<name>`. Unknown tools or settings, duplicate names and symlinks fail validation.
<!-- code: src/plugin.ts#ToolContext src/folder.ts#loadGraph src/plugin.ts#makePlugin src/folder.ts#GraphSettings src/plugin.ts#readPlugins -->

## Trust and reloads

Review plugins before use. They can access host files, environment and network during validation and execution. The engine supplies Effect, the AI SDK, `jose` and the public plugin, tracker and runner entry points. The graph supplies any additional dependencies. Helpers in subfolders affect the graph hash. Each loop pass reloads plugin declarations. Restart the loop after changing a runner or an imported helper.
<!-- code: src/plugin.ts#readPlugins bin/run.ts#serve studio/plugins.ts#makeStudioPagesPlugin -->

## Uploads

A session calls its selected plugin tools through an authenticated Model Context Protocol (MCP) endpoint. Calls and redacted results enter traces. See [transport and credentials](sandbox.md#secrets-on-the-host).
<!-- code: src/tools.ts#startTools -->

Save a PNG or JPEG in sandbox `/tmp`, run `agi file put <path>`, and pass the returned handle to a tool. `ctx.readFile(ref)` consumes it once. Unknown, consumed or cross-session handles fail. Each upload is limited to 10 MiB. A session can hold up to 32 unread handles and 64 MiB of unread data, and upload up to 256 MiB in total. The store saves uploaded bytes by hash in `data/files/`. Unread handles expire when the session closes. The built-in remote runner (`box`) cannot call tools served by the host.
<!-- code: src/files.ts#makeFiles src/store.ts#fileStore src/tools.ts#startTools src/remote.ts#whyBoxRefused -->

## Status hooks

`on.status` receives `{ issue, repo, from, to }` after a status change. Its context supplies the repository, settings and tracker search. On GitHub, `tracker.writeField(issue, { project, field, value })` needs `project` scope. A `null` value clears the field. Hooks run in the order of the `plugins` keys in `settings.yaml`. Plugins without settings follow in filename order. Errors are logged without stopping the run. See the [board example](../tests/fixtures/triggers/plugins/board.ts).
<!-- code: src/plugin.ts#StatusChange src/plugin.ts#HookContext src/run/settle.ts#announce src/run/hear.ts#readHooks src/plugin.ts#readPlugins src/tracker.ts#Tracker tests/fixtures/triggers/plugins/board.ts#settings -->

## Event hooks

An `on.event` hook can change [what a live run hears](workflows.md#what-a-live-run-hears). The engine starts with the workflow's decision and calls plugins in [hook order](#status-hooks). <!-- code: src/run/hear.ts#readHeard -->

```ts
  on: {
    event: ({ event }, { settings }) => {
      if (event.kind !== 'comment' || event.comment?.agentRequest) return undefined;
      return findRequest(event.comment?.body ?? '', settings.words) ? 'answer' : 'none';
    },
  },
```

The hook gets the event, the issue's `number`, `labels` and `author`, the run's `id`, `workflow`, `step` and `status`, and `does`, the outcome so far. Return an outcome or `{ does, why, usd }` to change the decision. Return `undefined` to leave it alone. The last applicable decision wins. The engine skips hooks for commands, bot or untrusted events, comments routed to another workflow and runs waiting on limits. <!-- code: src/plugin.ts#EventHook src/plugin.ts#HeardResult src/run/hear.ts#readHeard src/workflow.ts#getHeard -->

The context adds an abort `signal` and `priceUsd(model, tokens)`, which prices a model call with the instance's list prices (`AGENTGRAPH_PRICES`, the bundled table by default). Import `findRequest(body, marks)` from `@jannik-stacks/agi/plugins` to find a mark outside quotes and code. A hook has 30 seconds to return a valid result. After an exception, timeout or invalid result, the engine retries the event on the next pass. Later events for that run wait behind it, except for a stop. <!-- code: src/run/hear.ts#readHeard src/event.ts#findRequest src/prices.ts#getListPriceUsd src/plugin.ts -->

The trace keeps one [`heard`](runs.md#the-trace) line per hook and event, so a pass after a failure asks only the hooks that have no line yet. Its `usd` counts toward `usd-per-run`. See the [mention example](../tests/fixtures/triggers/plugins/mention.ts). <!-- code: src/types.ts#Trace src/trace.ts#getRunSpend tests/fixtures/triggers/plugins/mention.ts#settings -->

## Trackers

The built-in `folder` tracker keeps issues in local files. The `github` tracker reads and writes through a GitHub App. Select a built-in or plugin tracker by name with `--tracker` or the [instance settings](local.md#named-instances-and-settings). Outside an instance, an existing folder path selects the folder tracker. A tracker plugin must live in a graph on the host filesystem. The engine reports incompatible selections when you run `agi check`.
<!-- code: src/services.ts#pickTracker src/services.ts#readHostSettings src/tracker.ts#folderTracker src/github.ts#githubTracker -->

A plugin's `tracker({ repo, studio, app, dir })` returns a `TrackerSetup` with two members. Its `layer(trust, as)` provides the `Tracker` service. Its `origin` object contains the git URL in `origin`, an optional `local` flag and an optional token source. The service searches issues in this repository according to its trust rules. It may implement `status(number, to, names)` to display the issue's status.
<!-- code: src/plugin.ts#TrackerHost src/tracker.ts#TrackerSetup src/tracker.ts#Tracker src/tracker.ts#folderTracker src/github.ts#githubTracker -->

### Your own tracker

Wrap `folder` or `github` from `@jannik-stacks/agi/trackers`, as in the [folder plugin example](../examples/plugins/trackers/my-folder.ts). Preserve the instance's supplied `origin.git` for merge and export. Local CLI writes go directly to the folder. Set `status: false` in the graph’s `settings.yaml` to disable the tracker’s status display.
<!-- code: src/plugin.ts#TrackerHost src/services.ts#pickTracker src/services.ts#makeTrackerSetup src/tracker.ts#folder src/tracker.ts#folderTracker src/trackers.ts src/run/settle.ts#writeStatus examples/plugins/trackers/my-folder.ts -->

## Runners

A plugin's `runner` receives `RunnerHost` (`data`, `image`, `cache`, `direct`) and the plugin settings. It returns an Effect layer that provides `Runner`. Its `open` method prepares a command environment, called a box, for one checkout. The optional `whyRefused` method explains which graph settings it cannot support. See [runner selection](sandbox.md#runners).
<!-- code: src/plugin.ts#RunnerHost src/sandbox.ts#Runner src/services.ts#pickRunner src/services.ts#whyRunnerRefuses -->

For a remote service, import `makeBoxRunner(data, open, whyRefused?)` from `@jannik-stacks/agi/runners`. Supply an `open(work, graph)` function that returns an Effect yielding `{ op, run }`. The engine calls `op` for `init`, `push`, `pull`, `put` and `stop`. It calls `run` to stream command output and the final exit code. The [Modal runner](../examples/plugins/modal/modal.ts) implements both functions and checks which network restrictions it can enforce.
<!-- code: src/runners.ts src/remote.ts#makeBoxRunner examples/plugins/modal/modal.ts#makeModalRunner -->

## Auth

`auth` receives the host environment and settings, then checks each request's URL, headers and login form. It returns `{ kind: 'user', user }`, `{ kind: 'login', url }` or `{ kind: 'refuse', why }`. Every studio page, API, action and live connection passes this gate.
<!-- code: src/plugin.ts#AuthHost src/plugin.ts#AuthRequest src/plugin.ts#AuthResult -->

From a clone, select the plugin with `npm --prefix studio run dev -- --auth <name>`. Without this flag, the studio checks the instance environment, the `auth` setting in a graph on the host filesystem and the shell’s `AGENTGRAPH_AUTH`, in that order. It defaults to `token`. Repository graphs cannot select auth. Served instances must agree on auth and settings.
<!-- code: studio/dev.ts studio/auth.ts#readStudioAuth src/services.ts#pickAuth -->

`token` generates a random token and prints a login URL. `AGENTGRAPH_STUDIO_TOKEN` sets a fixed token. `password` uses `AGENTGRAPH_STUDIO_PASSWORD`. Explicitly selected `none` skips login. The [Cloudflare Access example](../examples/plugins/cloudflare-access.ts) checks signed headers and allowed email domains.
<!-- code: src/auths.ts#token src/auths.ts#password src/auths.ts#none examples/plugins/cloudflare-access.ts#settings -->

`AGENTGRAPH_STUDIO_KEY` sets a signing secret of at least 32 characters. `AGENTGRAPH_STUDIO_API_TOKEN` allows bearer access when the plugin requests login. Instance env overrides the shell. Signed cookies apply to the host and port, last one hour and renew for up to twelve hours. Changed signing inputs invalidate them. `POST /auth/logout` ends a session. Cross-site writes and live connections are rejected. `AGI_HOST` sets the listen address; `AGI_ALLOWED_HOSTS` lists allowed hostnames.
<!-- code: studio/auth.ts#readStudioAuth studio/auth.ts#makeStudioAuthPlugin src/auths.ts#isSameSecret studio/vite.config.ts#server -->

## Studio pages

`studio` declares a title, local TSX page URL, data schema and `read(settings, hosts)` effect. Optional `watch(settings, hosts)` returns folders to watch. `InstanceHosts` maps instance names to hosts that read runs, checks and tracker data, or `{ why }` for failures. Default-export a React component and set `page: new URL('./Page.tsx', import.meta.url)`. Call `usePluginData` from `@jannik-stacks/agi/studio` with the plugin name and shared browser-safe schema.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/types.ts#InstanceHosts src/types.ts#InstanceHost src/engine.ts#makeInstanceHost studio/src/plugins.ts#usePluginData -->

Graph plugins receive only their own [instance](index.md#terms). Their pages live at `/<instance>/plugins/<name>`. `agi studio --plugins <dir>` or `AGENTGRAPH_STUDIO_PLUGINS` selects a folder containing `plugins/` and `settings.yaml`. Its pages receive all served instances and live at `/plugins/<name>`, with a link to Runs.
<!-- code: studio/plugins.ts#readFolderPages studio/plugins.ts#readHosts studio/dev.ts studio/src/App.tsx#official studio/src/App.tsx#custom -->

Review pages as trusted code. They share the studio's origin and API permissions. Browser users may read, post comments and set labels through typed RPC. Other actions require the CLI. Stores opened through `?data=` are read-only.
<!-- code: src/actions.ts#Actions src/engine.ts#makeActionWebHandler src/engine.ts#runLocalActions studio/fixtures.ts#makeStudioDevApiPlugin studio/src/state.ts#runAction -->

`/api/plugins/<name>/data` serves snapshots capped at 16 MiB. Watched changes refresh the page. A failed refresh keeps the previous snapshot and shows an error. Readers and settings stay server-side. See [reload rules](#trust-and-reloads).
<!-- code: studio/plugins.ts#makeStudioPagesPlugin studio/plugins.ts#readStudioPages studio/plugins.ts#readWatchRoots -->

See [dashboard widgets](../examples/dashboard/README.md). [Results](checks.md#the-results-tab) uses the same descriptor and data hook at `/results`, even when the graph fails to load.
<!-- code: examples/dashboard/plugins/dashboard.ts examples/dashboard/plugins/dashboard/data.ts#DashboardSettings examples/dashboard/plugins/dashboard/data.ts#sources examples/dashboard/plugins/dashboard/read.ts#readDashboard -->

[Bench](../examples/plugins/bench/README.md) is an example plugin loaded with `--plugins`.
<!-- code: studio/plugins.ts#makeResultsPlugin studio/src/results/data.ts#ResultsData studio/src/results/ResultsPage.tsx#ResultsPage examples/plugins/bench/plugins/bench.ts -->

For the host that reads several stores or submits runs, see [the studio architecture](architecture.md#the-studio). <!-- code: src/engine.ts#makeEngineHost -->
