# Caveats

Rough edges known at merge time.

- A box chowns `/work` on every writable command, which costs time on big trees.
- A writable command in a box can still `chmod o+w` a file, which a later read-only command, as uid 1001, may then write.
- A box that cannot start commands as root refuses read-only commands with exit 126; only the test double runs that way.
- A box that restarts between `init` and `run` costs one failed command before it is pushed again.
- Modal resolves the gateway's addresses once per box. A gateway behind a CDN that changes address mid-box cuts the box off; it never widens.
- A toolchain install runs with network `open`, which a Modal box narrows to its own network, so installs fail in a Modal box without a matching image.
- The Modal runner terminates leftover boxes only when it starts, by tag; a box from another data root is left alone.
- The local contract rows run only with `AGENTGRAPH_E2E=1` and the sandbox image built.
- The `local` runner checks the host when its layer is built, once per image per process. The loop's layers pass `AGENTGRAPH_IMAGE`, so a graph with its own `image` also gets the stock image checked, and built when missing, on its first pass.
- Tests that build the production layers only for a tracker pick the `box` runner, since `local` would check Docker and the model stack.
- Plugin pages refresh on the instance's `data` topic. Tracker events alone do not refresh them, since the
  studio does not watch tracker folders. The dashboard's issue widget lags until a run changes.
- The instance host builds a tracker layer per read call. Fine for the folder tracker; a GitHub tracker pays
  token setup per call.
- The dashboard's issue widget counts `since` events, so a GitHub tracker reads every event in the window.
- The studio check now needs `@jannik-stacks/agi/plugins` aliases in the root tsconfig and vitest config,
  next to the existing studio tsconfig path. A published `.d.ts` for the studio entry is still missing.
- `/api/logs` now returns 404 for an instance whose `instance.yaml` fails to load, where it used to read the
  data folder anyway.
