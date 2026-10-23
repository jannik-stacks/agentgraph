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

See [sandbox isolation](sandbox.md#the-sandbox), [network rules](sandbox.md#the-network) and [checkout storage](runs.md#checkout).

The engine talks to the outside through four services. Each has a test double:

- The forge reads and writes GitHub, or a folder when run locally. <!-- code: src/forge.ts#Forge -->
- The store keeps runs and traces. <!-- code: src/store.ts#Store -->
- The sandbox runs commands in docker, or on the host in tests. <!-- code: src/sandbox.ts#Sandbox tests/doubles/sandbox.ts#host -->
- The session talks to a harness, or plays a script in tests. <!-- code: src/session.ts#Session tests/doubles/session.ts#scripted -->

## One run through the state machine

[The loop](loop.md) describes transitions, checks, retries and waiting.

| Engine code | Model judgment |
| --- | --- |
| Step transitions, tries and rounds caps | Session edits and proposals |
| Script checks and failure modes | Agent check verdicts |
| Proposal validation and application | Whether `until` holds |
| Push safety, triggers and trust | Questions for humans |

Judgment supplies proposals and verdicts; engine code decides transitions. Malformed replies fail the try. `transition` is pure and testable without I/O; `drive` performs the surrounding reads and writes. <!-- code: src/workflow.ts#transition src/engine.ts#land src/engine.ts#tick src/engine.ts#drive -->

## Bundling for hosting

`infra/local/docker-compose.yml` runs LiteLLM, its database, the egress proxy and Ollama relay. Runner and studio run as Node processes on the host.

The runner needs Docker access to start sandboxes and keeps App credentials. The studio is optional and can run anywhere with read-only access to the hub and data directory. An existing proxy can serve the runner through `AGENTGRAPH_PROXY_URL` and per-agent keys.
