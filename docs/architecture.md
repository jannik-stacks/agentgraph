# Architecture

This page shows where everything lives, how a run moves, and what is code versus judgement.
The engine means the runner's own code in `src`.

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

The engine is the only part that holds a GitHub token. A sandbox gets its own agent's proxy key and nothing else.

Sessions and the hub's `setup` reach only the model proxy and an egress allowlist, and scripts and checks reach nothing, see [The network](sandbox.md#the-network).

Each run works in its own git worktree of a bare mirror, see [Runs](runs.md#checkout).

The engine talks to the outside through four services. Each has a test double:

- The forge reads and writes GitHub, or a folder when run locally. <!-- code: src/forge.ts#Forge -->
- The store keeps runs and traces. <!-- code: src/store.ts#Store -->
- The sandbox runs commands in docker, or on the host in tests. <!-- code: src/sandbox.ts#Sandbox -->
- The session talks to a harness, or plays a script in tests. <!-- code: src/session.ts#Session -->

## One run through the state machine

```
 trusted event: a mention, a command or a label
        │
        v
 ┌────────────────────┐   pass    ┌────────────────────┐   pass    ┌────────────────────┐
 │ step: implement    │──────────>│ step: review       │──────────>│ step: merge        │──> done
 │ agent session      │           │ agent session      │           │ wait: human        │
 └─────────┬──────────┘           └─────────┬──────────┘           └─────────┬──────────┘
           │                                │ until does not hold            │ a person asks for changes
           │                                └──> back to implement           └──> back to implement
           │
           ├──> a check or proposal failed: the next try, in the same session
           ├──> ask, tries or rounds spent: waiting, until a human answers
           └──> a stop check, the minutes or spend limit, a sandbox failure: stopped
```

The three ways out under `implement` hold for every agent step. [The loop](loop.md) draws one try in detail.

Which part is which:

| Deterministic engine code                                                                    | LLM judgement                                    |
| -------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| Transitions between steps                                                                    | The session: what it writes and proposes         |
| The tries cap and the rounds cap                                                             | An agent-judged check: the reply is PASS or FAIL |
| Script checks and their modes (`warn`, `block`, `stop`)                                      | Whether the `until` sentence holds               |
| Which proposals are accepted and applied                                                     | What the agent asks a human                      |
| Push safety: a push never forces and only the host holds the token                           |                                                  |
| Triggers and trust: only a trusted command or label starts a run                             |                                                  |

<!-- code: src/workflow.ts#transition src/engine.ts#land src/engine.ts#tick -->

Judgement never moves a run by itself. An agent only proposes, a check only answers pass or fail, and the engine reads the answers and decides where the run goes. A reply that does not parse fails the try. `transition` is pure, so every path is a plain test. The engine loop around it reads each answer and applies it. <!-- code: src/engine.ts#drive -->

## Bundling for hosting

Today `infra/local/docker-compose.yml` runs the model proxy, its database, the egress proxy and the Ollama relay. The runner and the studio run as node processes on the host.

The planned bundle uses one compose file with three parts:

- The runner has access to the docker socket on its host because it starts the sandboxes.
- The proxy is LiteLLM with its database. It holds keys and spend logs.
- The studio only reads the data dir and needs nothing else.

The sandbox network and egress proxy sit beside them, as in `infra/local/docker-compose.yml`. The data dir is a volume shared by runner and studio.

The studio is optional. It can run anywhere that mounts the data dir read-only. The proxy can be one that already runs, since the engine needs only `BOTHUB_PROXY_URL` and the per-agent keys.

The runner cannot be split from docker, because a run is a container the runner starts. The GitHub side needs only the App credentials, which stay with the runner.
