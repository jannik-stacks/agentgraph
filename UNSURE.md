# Unsure

Decisions made without being sure. Each names what was picked and what would change it.

- **`RunnerHost` is a named type in `plugin.ts`**, next to `TrackerHost`, not a `Pick` of `Settings`: `plugin.ts` sits in the values layer and cannot import `Settings` (services) or `Runner` (sandbox), and a type import of `sandbox.ts` would also close the cycle folder, plugin, sandbox, folder. So the `runner` member is checked for its host and for returning a layer with no requirements (`Layer<never, unknown>`), but not for providing `Runner`; `pickRunner` checks that when it builds the layer (`Context.getOption`, error "runner X provides no Runner") instead of casting. A compile-time `Layer<Runner, SandboxError>` needs `Graph` moved out of `folder.ts` or a layering exception.
- **`AGENTGRAPH_RUNNER` from the shell counts with several instances**, unlike `AGENTGRAPH_TRACKER`. A runner is a property of the host, like `AGENTGRAPH_IMAGE`.
- **`agi check` builds the runner only when it is not `local`**, so a check never starts Docker or builds the image. A `local` graph is never refused at check time.
- **Modal's network is fixed per sandbox.** The SDK has `blockNetwork` and `cidrAllowlist` at create time and nothing per command, so a box reaches nothing, or the model gateway's addresses resolved at create time when the graph says `network: models`. Modal refuses graphs that mix commands without network and sessions, and graphs with sessions on the egress network.
- **The Modal client type is written from the libmodal sources**, not checked against an installed SDK; nothing was installed. The live smoke test is the check, and it was not run here.
- **Modal reads `box.sh` from `examples/deploy/cloudflare/`**, so a copied plugin needs that file beside it or a path change.
- **`makeBoxRunner` takes `data` first**, for its host-side sync dirs, and a box's `run` now yields a final `{ code }` instead of the exit frame line, so a runner that is not HTTP never formats a frame.
- `resume` is not an action yet. Its function, `instruct` with a resume instruction, needs the engine's full
  services (`start` with a tracker setup and harness choice). Running that inside the studio process felt too
  heavy. `say <n> ":restart"` and `":stop"` cover the per-issue cases through the `commands` gate.
- `stop` and `restart` stay CLI-only: they signal or spawn a loop process that may serve several instances.
- Actions are offered to every page, graph-local or operator, because pages share the studio origin anyway.
  Readers get no actions. If graph-local pages should not act, the route would need the page's name, which
  any same-origin script can forge.
- A plain studio (`--dir --data --tracker <folder>`) reads that tracker but refuses `say`, since it has no
  owner to post as. Named instances post as the instance owner.
- `readStudioPages` hands the instance host to graph plugins whose graph may come from the repo. Reads there
  add no authority beyond what host code already has, but it is worth a second look.
- `/api/results` and the Results plugin still read the same sheet twice through `bin/results.ts`. Moving
  `readRunResults` onto the instance store would make one path; it reads sync files today.
- `InstanceHost` is exported from `@jannik-stacks/agi/trackers`, not `/plugins`. `src/plugin.ts` must stay a
  leaf for the import-cycle lint, and the host type pulls in the tracker and store. A reader types its own
  host parameter; `makePlugin` infers it, so nothing checks that the served host matches at compile time.
- **Studio auth is one gate for every served instance.** Each instance's env file and graph may pick it, but a studio
  of several refuses to start unless they agree on the name, the plugin settings and every `AGENTGRAPH_AUTH` and
  `AGENTGRAPH_STUDIO_*` value. A host-level studio setting would be simpler if multi-instance studios get hosted.
- **The start token also signs sessions** when `AGENTGRAPH_STUDIO_KEY` is unset, which saves a second generated
  secret. Anyone with the token can log in anyway, so it gives nothing extra away.
- **The gate knows two names**: it prints the login URL for `token` and warns for `none` beyond loopback. A plugin
  hook for start-up lines would remove that, but nothing else needs one yet.
