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

Names outside the harness's built-ins must name registered plugin tools; unknown names fail `check`.
`execute` receives typed input and a context with `repo`, read-only `tracker.searchIssues`,
`abortSignal` and its own `settings`. Search stays within this repo and applies the tracker's text trust rules.
`readFile(ref)` returns fresh image bytes and their PNG or JPEG media type from a session handle.
Save images in sandbox `/tmp`, run `agi file put <path>`, then pass the handles to a tool.
The host opens no agent-supplied path. A successful read consumes the handle and frees its slot and
held bytes. Unread handles expire at session close; consumed, unknown and cross-session
handles fail. Uploads are acknowledged only after raw bytes are saved at `data/files/<sha256>`
with a synced temporary file and atomic rename, and the trace is synced. Put/read traces contain
handle, size, type, hash and the trace session key. Closing a session drops its handles, while durable
bytes remain available to the store by hash. Durable reads reject a hash mismatch.
<!-- code: src/files.ts#makeFiles src/store.ts#fileStore src/tools.ts#startTools -->

Binary uploads reuse session authentication and relay with a separate route: 10 MiB per file,
32 unread files at once, 64 MiB held, 256 MiB cumulative input and two concurrent uploads per session.
Chunk counts enforce limits regardless of Content-Length. PNG/JPEG magic bytes are checked;
no host image parser runs. Isolated decoding and re-encoding remain a later option.
Host plugins still run as trusted code.
<!-- code: src/plugin.ts#ToolContext src/folder.ts#loadGraph src/tracker.ts#parseIssueSearch -->

Plugin names may contain letters, digits, underscores and hyphens, starting with a letter.
A plugin can declare `settingsSchema`; it decodes only `plugins.<name>` in `settings.yaml`.
Bind its type once with `makePlugin<typeof settings.Type>({ name, settingsSchema: settings, tools: { ... } })`;
handlers then infer `ctx.settings`. Without a schema, that plugin's settings must be absent.
Unknown settings, duplicate plugin or tool names and symlink entries fail `check`.
<!-- code: src/plugin.ts#makePlugin src/folder.ts#GraphSettings src/plugin.ts#readPlugins -->

Imports run on the host during `check`. Review them as host code: the context supplies no tracker writes
or engine services, but TypeScript can still read the host environment, files and network.
No shipped example lets an agent or a `run` step return `merge`: either could land a plugin change that
then runs on the host with its secrets. `npm run check:examples` fails on such a grant, and the engine applies
a `merge` only from a step whose `returns` lists it.
<!-- code: bin/merge-grants.mjs -->

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
<!-- code: src/tools.ts#startTools src/harnesses.ts#harnessSession src/remote.ts#makeBoxRunner -->

The listener binds to loopback on macOS, or to the Docker bridge gateway on Linux with peer subnet
checks. A per-session relay runs as non-root with a read-only root on the sandbox networks and
forwards only that host port. It is needed because the isolated sandbox cannot reach the host
listener directly. The relay holds no bearer.
Both listener and relay close when the session ends; cancellation traces finish before closure.
<!-- code: src/docker.ts#dockerRunner src/docker.ts#dockerArgs -->

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
[status](workflows.md#status-on-the-issue), with `{ issue, repo, from, to }`; `from` is absent on the first status.
The context holds `repo`, the plugin's `settings`, `tracker.searchIssues` and, on GitHub, `tracker.writeField(issue,
{ project, field, value })`, which sets a single-select field of the issue's card on a project board, such as Status, and
adds the card when it is missing; `value: null` clears the field. It uses the project token, which needs the `project`
scope: `gh auth refresh -s project`. Hooks run in filename order. A hook that throws is logged and the run goes on.
<!-- code: src/plugin.ts#StatusChange src/plugin.ts#HookContext src/run/settle.ts#announce src/tracker.ts#Tracker -->

```ts
export default makePlugin({
  name: 'notify',
  on: {
    status: async ({ issue, to }) => {
      if (to.startsWith('needs')) await fetch(/* ... */);
    },
  },
});
```

`examples/board/plugins/board.ts` uses it to mirror the status onto fields of a GitHub project board.
<!-- code: examples/board/plugins/board.ts -->

## Trackers

A plugin can provide `tracker` instead of tools. It receives `{ repo, studio, app, dir }` and returns `layer(trust)`, a
layer that provides the `Tracker`, and `origin`, the git remote sandboxes mirror. `--tracker <value>`, else
`AGENTGRAPH_TRACKER` in the instance's env file, else the instance's `tracker`, else `AGENTGRAPH_TRACKER` in the shell,
else `github` when App credentials are set, picks one: a value that names a plugin selects it, and any
other value is the path of a folder for the built-in `folder` tracker, relative to the working directory. A plugin
picked by name gets `AGENTGRAPH_TRACKER_DIR` as its `dir`, and a local instance picks the `tracker` its
[instance.yaml](runs.md#instanceyaml) names, `folder` by default, with its `tracker/` as the folder. Plugins of
the graph `--dir` names count; a graph read from the repo cannot pick its own tracker. `agi check --dir <graph>` says
when the selection names nothing, names a plugin without a tracker, or needs a graph read from the repo. A tracker's
optional `status(n, to, names)` shows an issue's status by the names in the graph's `status` setting: `github` swaps
labels, `folder` moves the issue's folder. A status the tracker refuses is shown again on the next pass.
<!-- code: src/plugin.ts#TrackerHost src/services.ts#readHostSettings src/services.ts#pickTracker src/tracker.ts#folder src/github.ts#github src/run/settle.ts#writeStatus -->

### Your own tracker

The built-ins ship as `folder` and `github` in `@jannik-stacks/agi/trackers`, so a graph plugin can wrap one under a
new name. `examples/plugins/trackers/my-folder.ts` wraps `folder` and adds `ci-bot` to the trusted logins; copy it
into the graph's `plugins/`.

On an instance the tracker keeps the folder it is given: `agi` and the loop, on every graph change, refuse one whose `origin.git` lies elsewhere, since
merge and export work on that remote. The CLI verbs write your side, issues, comments, reviews and closes, straight to
the folder, so a wrapper shapes what the bot reads and writes.

To change more, copy `folderTracker` from `src/tracker.ts` in a clone into the plugin and edit it. Pick the plugin
with `--tracker my-folder`, `AGENTGRAPH_TRACKER=my-folder` or `tracker: my-folder` in instance.yaml, and run
`agi check --dir <graph>` to see that the name resolves to a plugin with a tracker in a graph the host reads. A graph
plugin named `folder` would replace the built-in, but a new name keeps the swap visible. Turning status off needs no
fork: `status: false` in settings.yaml.
<!-- code: src/plugin.ts src/trackers.ts examples/plugins/trackers/my-folder.ts -->

## Runners

A plugin can provide `runner` instead of tools. It receives the host, `RunnerHost` (`{ data, image, cache, direct }`),
and its own settings, and returns a layer that provides the `Runner`; the engine checks that it does when it builds
the layer: `open` starts a box for one checkout and `whyRefused` names
what in a graph it cannot run. `makeBoxRunner` in `@jannik-stacks/agi/runners` builds one from two calls, `op` for the
`box.sh` steps and `run` for a command, so a plugin only moves bytes. Pick it with `--runner <name>`,
`AGENTGRAPH_RUNNER` or `runner:` in instance.yaml. Only plugins of a graph the host reads count, like trackers, and
`agi check --dir <graph>` says when the name resolves to nothing or the runner refuses the graph.
`examples/plugins/modal/` runs boxes on Modal. <!-- code: src/plugin.ts#makePlugin src/runners.ts src/remote.ts#makeBoxRunner src/services.ts#whyRunnerRefuses -->

## Auth

Every studio request, the page, its modules, the API, plugin data and actions, and the live socket, passes one
gate. A plugin can provide `auth`: given the host env and its settings, it returns a function that takes a request
(`url`, `headers`, and `form` on a login post) and answers `{ user }`, `{ login: url }` or `{ refuse: why }`. The
studio keeps the session: a signed cookie that lasts an hour and renews while in use. `npm run dev -- --auth <name>`,
else `AGENTGRAPH_AUTH` in the instance's env file, else `auth:` in settings.yaml, else `AGENTGRAPH_AUTH` in the
shell, else `token` picks one, from the built-ins and the plugins of a graph on the host. A studio of several
instances needs them to agree.
<!-- code: src/plugin.ts#AuthResult src/services.ts#pickAuth studio/auth.ts#makeStudioAuthPlugin -->

```yaml
auth: cloudflare-access
plugins:
  cloudflare-access:
    team: https://myteam.cloudflareaccess.com
    audience: <the Access application's AUD tag>
    domains: [example.com]
```

- `token`, the default: the studio makes a random token at start and prints a login URL with it.
- `password`: `AGENTGRAPH_STUDIO_PASSWORD` from the env file, posted from the login form.
- `none`: no login. Pick it by name; the studio warns when it listens beyond loopback.
- `examples/plugins/cloudflare-access.ts`: checks Cloudflare Access's signed header against the team's keys and
  lets in emails on the listed domains. Set up Google or another login in Cloudflare.
<!-- code: src/auths.ts examples/plugins/cloudflare-access.ts -->

The env file may also set `AGENTGRAPH_STUDIO_KEY`, which signs sessions so they outlive a restart, and
`AGENTGRAPH_STUDIO_API_TOKEN`, which scripts send as `Authorization: Bearer <token>`. The cookie is HttpOnly,
SameSite=Strict, and Secure behind HTTPS. Against cross-site requests the gate refuses any request but GET and HEAD
whose `Origin` names another host. To host the studio, set `AGI_HOST` and, behind a proxy, `AGI_ALLOWED_HOSTS`.

## Studio pages

A plugin can provide `studio` instead of tools. It declares a title, a local TSX page URL, an Effect
Schema for its data and a `read(settings, host)` effect. Optional `watch(settings, host)` returns the
folders whose changes refresh the page, such as the instance's `host.data`. The reader gets this plugin's decoded
settings and the instance's host: its `data` folder, `store` (`list`, `listRecords`, `getRecord`, `read`,
`readChecks`, `readLog`), `tracker` (`issues`, `issue`, `since`), `readRuns()`, each run with its labels and
latest checks, and `actions`. These are the
reads the studio's own Runs and Graph pages use, scoped to the one instance the page is served
for. Type the reader's host with `InstanceHost` from `@jannik-stacks/agi/trackers`, as in
`read(settings, host: Pick<InstanceHost, 'store' | 'tracker'>)`. Loading declarations does not execute readers or import TSX. Host code remains trusted; namespaces
are not isolation.
<!-- code: src/plugin.ts#makePlugin src/plugin.ts#readPlugins src/engine.ts#InstanceHost src/engine.ts#makeInstanceHost -->

A page default-exports a React component. Set `page: new URL('./Page.tsx', import.meta.url)`;
Vite compiles it and its CSS. Import `usePluginData` from `@jannik-stacks/agi/studio` in the page.
Pass its plugin name and a browser-safe data schema shared with the host reader. The studio also
exports its UI (`Live`, `Loading`, `Muted`, `Button`, `Select`, `Badge`, `Disclosure`, `Tooltip` and more),
query/navigation atoms and results components through that browser entry.

A page acts with `runAction(verb, ...args)`, which runs the host action of that name on the page's
instance. Each action is a schema for its arguments and the function behind the CLI verb: `runAction('say', 12, 'go on')` posts `/agent go on` like `agi say`, and
`runAction('label', runId, { arm: 'base' })` sets run labels like `agi label`. `say` takes the same
[commands](workflows.md#commands), so `':restart:implement'` or `':stop'` reach a run under the graph's
`commands` gate. Like `agi say`, it posts only to a local tracker and never drives; a running loop picks the
comment up. The studio accepts actions only as same-origin JSON posts to `/api/actions/<verb>`.
<!-- code: studio/src/plugins.ts#runAction studio/fixtures.ts#makeStudioDevApiPlugin src/tracker.ts#writeAgentComment -->
<!-- code: studio/src/plugins.ts#usePluginData studio/plugins.ts#makeStudioPagesPlugin -->

Pages appear at `/plugins/<name>` and read HTTP snapshots from `/api/plugins/<name>/data`. In a studio of named
instances they sit under `/<instance>`, and each reads its own instance's plugin with `?instance=<instance>`. One SSE
connection refreshes a mounted reader when one of its plugin's watched folders changes. A failed
refresh keeps the last good data and shows an error. Snapshots are capped at 16 MiB.
Host readers, settings and data roots never enter the page manifest. Pages share the studio origin
and its API authority; review them like host plugins. Registering a page starts no job. Restart the
studio after registrations change. Preview needs a host API for live data.

The header lists the studio's own pages first: Graph, Runs, the built-in Results and Bench, then Docs. Page plugins from the graph sit in a second group beside them, which shows only when there is one.

The [dashboard experiment](../examples/dashboard/README.md) uses this same seam for configurable
run states, check attempts, tokens, reported cost and tracker activity. Its `plugins.dashboard` settings
list counter, line, bar or table widgets with UTC time windows. It reads through the instance host, imports
only `@jannik-stacks/agi/plugins`, and refreshes through the studio's existing live connection.
It adds no storage or dependency. Its charts use d3-scale, which the studio shares with page plugins
the way it shares React.
<!-- code: examples/dashboard/plugins/dashboard.ts examples/dashboard/plugins/dashboard/read.ts#readDashboard -->

Results and Bench are built-in plugins using this same descriptor, data endpoint and hook. They keep
`/results` and `/bench` and need no graph-local file; both names are reserved. Bench is one page over
every served instance and every set from `npm run dev -- --bench <sets>` ([Bench](bench.md#cost-against-quality)). Results
reads one sheet from the selected data folder and shows an error when it fails. Results refreshes with
the instance's run data; Bench watches every store it reads. Both remain available when the graph cannot load; the
Graph page still shows configuration problems.
<!-- code: studio/src/results/data.ts#ResultsData studio/src/results/ResultsPage.tsx#ResultsPage studio/src/bench/data.ts#BenchData -->

## Engine access

A plugin the operator registers in host code, such as Bench, can declare `engine(host, settings)`. The
host lists the run stores it may read (`configs`, each a name, a data dir and an optional instance),
reads a store's runs with their labels and latest checks (`readRuns`), and starts or imports a run
(`submit`). Submit checks the labels and stamps the run's origin with the plugin's own name, so a
plugin cannot pose as another. Whatever `engine` returns is passed to the studio page's `read` and
`watch`. The studio's host only reads; submitting works where the operator's command builds a
submitting host, as `bin/bench.ts` does. A graph plugin file that declares `engine` is refused, so
graph tools never get access to other instances. Every other plugin reads only its own instance, and only
the page, acting as the person using the studio, can call actions. Loop verbs such as `stop` and `restart`
stay with the CLI, since one loop serves several instances.
<!-- code: src/engine.ts#EngineHost src/engine.ts#makeEngineHost -->
