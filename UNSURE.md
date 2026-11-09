# Unsure

Decisions made without being sure. Each names what was picked and what would change it.

- **`RunnerHost` is a named type in `plugin.ts`**, next to `TrackerHost`, not a `Pick` of `Settings`: `plugin.ts` sits in the values layer and cannot import `Settings` (services) or `Runner` (sandbox), and a type import of `sandbox.ts` would also close the cycle folder, plugin, sandbox, folder. So the `runner` member is checked for its host and for returning a layer with no requirements (`Layer<never, unknown>`), but not for providing `Runner`; `pickRunner` checks that when it builds the layer (`Context.getOption`, error "runner X provides no Runner") instead of casting. A compile-time `Layer<Runner, SandboxError>` needs `Graph` moved out of `folder.ts` or a layering exception.
- **`AGENTGRAPH_RUNNER` from the shell counts with several instances**, unlike `AGENTGRAPH_TRACKER`. A runner is a property of the host, like `AGENTGRAPH_IMAGE`.
- **`agi check` builds the runner only when it is not `local`**, so a check never starts Docker or builds the image. A `local` graph is never refused at check time.
- **Modal's network is fixed per sandbox.** The SDK has `blockNetwork` and `cidrAllowlist` at create time and nothing per command, so a box reaches nothing, or the model gateway's addresses resolved at create time when the graph says `network: models`. Modal refuses graphs that mix commands without network and sessions, and graphs with sessions on the egress network.
- **The Modal client type is written from the libmodal sources**, not checked against an installed SDK; nothing was installed. The live smoke test is the check, and it was not run here.
- **Modal reads `box.sh` from `examples/deploy/cloudflare/`**, so a copied plugin needs that file beside it or a path change.
- **`makeBoxRunner` takes `data` first**, for its host-side sync dirs, and a box's `run` now yields a final `{ code }` instead of the exit frame line, so a runner that is not HTTP never formats a frame.
- `resume` is an action only where a host can drive: the CLI and a studio of named instances. A plain studio
  refuses it with "this host does not drive runs", since it has no instance to start from.
- The CLI calls actions in process through the same HTTP codec as the studio and never reaches a remote host, so
  there is no remote write to fall back from. A loop that serves the group (planned) must keep that: a failed
  remote call is reported, never retried locally.
- The action layer grew production code by about 130 lines before any caller moved onto it. It was kept
  because the next step deletes the per-verb routes and reads it replaces; the net is measured over both.
- `stop` and `restart` stay CLI-only: they signal or spawn a loop process that may serve several instances.
- Actions are offered to every page and every reader, graph-local or operator: the maintainer chose no
  distinction for now. Pages share the studio origin anyway, so a gate on the page's name would be forgeable.
- `say` posts where `agi say` does: only to a local tracker (`origin.local` of the tracker setup). A plain
  studio (`--dir --data --tracker <folder>`) wires the folder through the folder plugin's setup and posts as
  the local user, since it has no instance owner. Named instances post as the instance owner.
- The dashboard caches its tracker `since` read per window start for one minute, in the example's own reader
  (a map per host tracker). A cache inside the host's `tracker.since` would serve every page, but it would
  key on cursor and columns and change what the core read means for one consumer, so the smaller reader-side
  cache won.
- The dashboard skips runs that ended before its widest window and runs no widget names, before reading
  traces. `listRecords({ workflow })` would not help: it reads every `run.json` before filtering, and one
  filter cannot express widgets with different workflows.
- The dashboard watches its instance's data folder, so it still re-reads after any run write. That is the
  refresh it needs for live counts; the tracker read inside it is cached, so a live run no longer repeats
  GitHub scans back to back.
- `readStudioPages` hands the instance host to graph plugins whose graph may come from the repo. Reads there
  add no authority beyond what host code already has, but it is worth a second look.
- `/api/results` and the Results plugin still read the same sheet twice through `bin/results.ts`. Moving
  `readRunResults` onto the instance store would make one path; it reads sync files today.
- `InstanceHost` is exported from `@jannik-stacks/agi/trackers`, not `/plugins`. `src/plugin.ts` must stay a
  leaf for the import-cycle lint, and the host type pulls in the tracker and store. A reader types its own
  host parameter; `makePlugin` infers it, so nothing checks that the served host matches at compile time.
- Left from the studio review: the dashboard keeps its `why` field (the page would derive it from source and
  skips), `InstanceHost` keeps `tracker.issues`/`issue` and `store.readLog`/`getRecord` (the trim waits on the
  types refactor), and a bench data folder still gets a whole instance host for its store. The `ResultBadge`
  wrapper stays: `runRow` is a plain function, so the hook needs that component.
- **Studio auth is one gate for every served instance.** Each instance's env file and graph may pick it, but a studio
  of several refuses to start unless they agree on the name, the plugin settings and every `AGENTGRAPH_AUTH` and
  `AGENTGRAPH_STUDIO_*` value. A host-level studio setting would be simpler if multi-instance studios get hosted.
- **The session key is a hash of every `AGENTGRAPH_AUTH` and `AGENTGRAPH_STUDIO_*` value**, so rotating any of
  them logs everyone out, and the start token stands in for a key when `AGENTGRAPH_STUDIO_KEY` is unset. A random
  start token changes on every restart, so `token` sessions do too, which matches its login URL.
- **The gate knows two names**: it prints the login URL for `token` and warns for `none` beyond loopback. A plugin
  hook for start-up lines would remove that, but nothing else needs one yet.
