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
