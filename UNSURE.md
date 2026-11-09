# Unsure

Decisions made without being sure. Each names what was picked and what would change it.

- **Runner host is `{ data, image, cache, direct }`**, the docker runner's own parameter, not a slice of `Settings`; layering keeps `plugin.ts` from importing `Settings`. A plugin's `runner` host is typed by the plugin, so the engine casts what it gets back.
- **`AGENTGRAPH_RUNNER` from the shell counts with several instances**, unlike `AGENTGRAPH_TRACKER`. A runner is a property of the host, like `AGENTGRAPH_IMAGE`.
- **`agi check` builds the runner only when it is not `local`**, so a check never starts Docker or builds the image. A `local` graph is never refused at check time.
- **Modal's network is fixed per sandbox.** The SDK has `blockNetwork` and `cidrAllowlist` at create time and nothing per command, so a box reaches nothing, or the model gateway's addresses resolved at create time when the graph says `network: models`. Modal refuses graphs that mix commands without network and sessions, and graphs with sessions on the egress network.
- **The Modal client type is written from the libmodal sources**, not checked against an installed SDK; nothing was installed. The live smoke test is the check, and it was not run here.
- **Modal reads `box.sh` from `examples/deploy/cloudflare/`**, so a copied plugin needs that file beside it or a path change.
- **`makeBoxRunner` takes `data` first**, for its host-side sync dirs, and a box's `run` now yields a final `{ code }` instead of the exit frame line, so a runner that is not HTTP never formats a frame.
