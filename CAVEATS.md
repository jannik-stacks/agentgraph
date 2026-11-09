# Caveats

Rough edges known at merge time.

- A box walks `/work` on every command, a chown before a writable one and a chmod before a read-only one, which costs time on big trees.
- A box that cannot start commands as root refuses read-only commands with exit 126; only the test double runs that way.
- A box that restarts between `init` and `run` costs one failed command before it is pushed again.
- Modal resolves the gateway's addresses once per box. A gateway behind a CDN that changes address mid-box cuts the box off; it never widens.
- A toolchain install runs with network `open`, which a Modal box narrows to its own network, so installs fail in a Modal box without a matching image.
- The Modal runner terminates leftover boxes only when it starts, by tag; a box from another data root is left alone.
- The local contract rows run only with `AGENTGRAPH_E2E=1` and the sandbox image built.
- The `local` runner checks the host when its layer is built, once per image per process. The loop's layers pass `AGENTGRAPH_IMAGE`, so a graph with its own `image` also gets the stock image checked, and built when missing, on its first pass.
- Tests that build the production layers only for a tracker pick the `box` runner, since `local` would check Docker and the model stack.
- Plugin pages refresh only on their own watched folders. Tracker events alone do not refresh them, since the
  studio does not watch tracker folders. The dashboard's issue widget lags until a run changes.
- The dashboard's issue widget counts `since` events, so a GitHub tracker reads every event in the window,
  at most once a minute per window.
- The example dashboard page is type-checked by `examples/dashboard/tsconfig.json` in `check:examples`, which
  maps `@jannik-stacks/agi/studio` to the studio source. A published `.d.ts` for the studio entry is still missing.
- Password logins have no rate limit; put Cloudflare Access in front of a studio on the internet.
- `vite preview` is not gated.
- `agi studio` has no `--auth` flag; use `AGENTGRAPH_AUTH` or `npm run dev -- --auth`.
- The live socket stays open after its session expires; it carries only change topics.
- The `token` login URL carries the start token, so it lands in browser history and proxy logs. With `AGI_HOST`
  beyond loopback, prefer `password` or Cloudflare Access.
