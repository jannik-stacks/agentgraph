# Unsure

Decisions made without being sure. Each names what was picked and what would change it.

- **`RunnerHost` is a named type in `plugin.ts`**, next to `TrackerHost`, not a `Pick` of `Settings`: `plugin.ts` sits in the values layer and cannot import `Settings` (services) or `Runner` (sandbox), and a type import of `sandbox.ts` would also close the cycle folder, plugin, sandbox, folder. So the `runner` member is checked for its host and for returning a layer with no requirements (`Layer<never, unknown>`), but not for providing `Runner`; `pickRunner` checks that when it builds the layer (`Context.getOption`, error "runner X provides no Runner") instead of casting. A compile-time `Layer<Runner, SandboxError>` needs `Graph` moved out of `folder.ts` or a layering exception.
- **`AGENTGRAPH_RUNNER` from the shell counts with several instances**, unlike `AGENTGRAPH_TRACKER`. A runner is a property of the host, like `AGENTGRAPH_IMAGE`.
- **`agi check` builds the runner only when it is not `local`**, so a check never starts Docker or builds the image. A `local` graph is never refused at check time.
- **Modal's network is fixed per sandbox.** The SDK has `blockNetwork` and `cidrAllowlist` at create time and nothing per command, so a box reaches nothing, or the model gateway's addresses resolved at create time when the graph says `network: models`. Modal refuses graphs that mix commands without network and sessions, and graphs with sessions on the egress network.
- **The Modal client type is written from the libmodal sources**, not checked against an installed SDK; nothing was installed. The live smoke test is the check, and it was not run here.
- **Modal reads `box.sh` from `examples/deploy/cloudflare/`**, so a copied plugin needs that file beside it or a path change.
- **`makeBoxRunner` takes `data` first**, for its host-side sync dirs, and a box's `run` now yields a final `{ code }` instead of the exit frame line, so a runner that is not HTTP never formats a frame.
