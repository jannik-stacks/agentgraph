# Architecture

The engine is the runner code in `src/`.

## Where everything lives

```
 GitHub: issues, comments, pull requests
      ^                          │
      │ writes, with the App     │ events, read through the App
      │                          v
┌─────────────────────────────────────────────────────────────────┐
│ host                                                            │
│  runner process = the engine                                    │
│    looks at the repo, begins and drives runs                    │
│    pushes and opens pull requests through the Git API           │
│         │                                 │                     │
│         │ docker run --rm                 │ reads and writes    │
│         v                                 v                     │
│  ┌──────────────────────────┐  ┌─────────────────────────────┐  │
│  │ sandbox                  │  │ data dir                    │  │
│  │ one session              │  │ <run id>/run.json           │  │
│  │ /work: git worktree      │  │ <run id>/trace.jsonl        │  │
│  │ no GitHub token          │  │ mirror.git, work/, homes/   │  │
│  └────────────┬─────────────┘  │ news/<id>/news.md           │  │
│               │ model calls    └──────────────┬──────────────┘  │
│               v                               │                 │
│  ┌──────────────────────────┐                 v                 │
│  │ LiteLLM proxy            │  studio reads the hub,            │
│  │ aliases, one key per     │  run.json and trace               │
│  │ agent, spend logs        │                                   │
│  └────────────┬─────────────┘                                   │
└───────────────┼─────────────────────────────────────────────────┘
                v
         model providers
```

<!-- code: src/main.ts#start -->

The engine talks to the outside through four services, each with a stand-in for tests:

- The forge reads and writes GitHub, or a folder when run locally. <!-- code: src/forge.ts#Forge -->
- The store keeps runs and traces. <!-- code: src/store.ts#Store -->
- The sandbox runs commands in docker, or on the host in tests. <!-- code: src/sandbox.ts#Sandbox tests/doubles/sandbox.ts#hostSandbox -->
- The session talks to a harness, or plays a script in tests. <!-- code: src/session.ts#Session tests/doubles/session.ts#replaySession -->

## One run through the state machine

[The loop](loop.md) describes transitions, checks, retries and waiting.

| Engine code | Model judgment |
| --- | --- |
| Step transitions, tries and rounds caps | Session edits and proposals |
| Script checks and failure modes | Agent check verdicts |
| Proposal validation and application | Whether `until` holds |
| Push safety, triggers and trust | Questions for humans |

Models supply proposals and verdicts; engine code decides the transitions, and a malformed reply fails the try. `transition` is pure and testable without I/O; `drive` does the reads and writes around it. <!-- code: src/workflow.ts#transition src/engine.ts#land src/engine.ts#tick src/engine.ts#drive -->

## Hosting

`infra/local/docker-compose.yml` runs the proxy and its database, the egress proxy and the Ollama relay. The runner and the studio are Node processes on the host. The runner needs Docker and the App credentials. The studio is optional and needs only read access to the hub and the data directory. An existing proxy works through `AGENTGRAPH_PROXY_URL` and per-agent keys.
