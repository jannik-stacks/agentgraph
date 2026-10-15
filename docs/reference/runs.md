# Runs

The record every harness session leaves, and how a session runs.

A run is one harness session or script, stored on disk by `openStore`. The layout is
on [Runs and storage](../runs.md).

See `Run` in [src/store.ts](../../src/store.ts).

See `RunStatus` in [src/store.ts](../../src/store.ts).

## Running a session

`runJob` starts the harness, streams its events into the store and never fails: a timeout, a loop or a
container that never started all become a run status. The session always runs in a container built by
`dockerRun`; when the sandbox is unavailable the run fails as `sandbox-failed` instead of running on the
host. The setup is on [Sandbox and models](../sandbox.md).

## After a crash

See `reconcile` in [src/store.ts](../../src/store.ts).

Each run works in its own worktree of a bare mirror, see `workspaces`.
