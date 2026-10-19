# Architecture

This page shows where everything lives, how a run moves, and what is code versus judgement.
The engine means the runner's own code in `src`.

## Where everything lives

```
 GitHub: issues, comments, pull requests
      ▲                          │
      │ writes, with the App     │ events, read through the App
      │                          ▼
┌─────────────────────────────────────────────────────────────────┐
│ host                                                            │
│  runner process = the engine          code: src/main.ts#start   │
│    looks at the repo, begins and drives runs                    │
│    pushes and opens pull requests through the Git API           │
│         │                                 │                     │
│         │ docker run --rm                 │ reads and writes    │
│         ▼                                 ▼                     │
│  ┌──────────────────────────┐  ┌─────────────────────────────┐  │
│  │ sandbox                  │  │ data dir                    │  │
│  │ one session              │  │ <run id>/run.json           │  │
│  │ /work: git worktree      │  │ <run id>/trace.jsonl        │  │
│  │ no GitHub token          │  │ mirror.git, work/, homes/   │  │
│  └────────────┬─────────────┘  │ news/<id>/news.md           │  │
│               │ model calls    └──────────────┬──────────────┘  │
│               ▼                               │                 │
│  ┌──────────────────────────┐                 ▼                 │
│  │ LiteLLM proxy            │  studio reads the hub,            │
│  │ aliases, one key per     │  run.json and trace               │
│  │ agent, spend logs        │                                   │
│  └────────────┬─────────────┘                                   │
└───────────────┼─────────────────────────────────────────────────┘
                ▼
         model providers
```

The engine is the only part that holds a GitHub token. A sandbox gets its own agent's proxy key and nothing else.

Sessions and the hub's `setup` run on an internal network whose only exits are the model proxy, an Ollama relay to the host, and an egress proxy that allows HTTPS to `github.com`, `codeload.github.com`, `objects.githubusercontent.com` and `registry.npmjs.org`. So `npm install` and cloning from GitHub work; other registries and the open web do not. A hub with `network: models` reaches the model proxy only. Scripts and checks get no network at all. See [The network](sandbox.md#the-network).

Each run works in its own git worktree of the bare mirror. The mirror is mounted read-only. See [Sandbox](sandbox.md) and [Runs](runs.md).

The engine talks to the outside through four services. Each has a test double:

- `code: src/forge.ts#Forge`
- `code: src/store.ts#Store`
- `code: src/sandbox.ts#Sandbox`
- `code: src/session.ts#Session`

## One run through the state machine

```
 trusted event (command or label)
        │
        ▼
 ┌──────────────┐   pass    ┌──────────────┐   pass    ┌──────────────┐
 │ step A       │──────────→│ step B       │──────────→│ wait: human  │──→ done
 │ agent, skill │           │ reviewer     │           │              │
 └──────┬───────┘           └──────┬───────┘           └──────┬───────┘
        │ try ends                 │ until does not hold      │ asks for changes
        ▼                          │ (back, rounds cap)       │
 script checks, all at once        └──→ back to step A        └──→ back to step A
        │ block failed? feedback
        ▼                          tries cap spent, rounds cap spent, ask,
 agent checks (PASS or FAIL)       or a session over its minutes
        │ failed? feedback                    │
        ▼                                     ▼
 same session, next try            run waits (comment on the issue) or stops
        │ all pass
        ▼
 proposals applied by the engine (push, pull request, comment)
```

Which part is which:

| Deterministic engine code                                              | LLM judgement                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Transitions between steps: `code: src/workflow.ts#transition`     | The session: what it writes and proposes       |
| The tries cap and the rounds cap                                       | An agent-judged check: the reply is PASS or FAIL |
| Script checks and their modes (`warn`, `block`, `stop`)                | Whether the `until` sentence holds             |
| Which proposals are accepted and applied: `code: src/engine.ts#land` | What the agent asks a human                 |
| Push safety: a push never forces and only the host holds the token     |                                                |
| Triggers and trust: only a collaborator's command or label starts a run, `code: src/engine.ts#tick` |                |

Judgement never moves a run by itself. An agent only proposes, a check only answers pass or fail, and the engine reads the answers and decides where the run goes. A reply that does not parse fails the try. `transition` is pure, so every path is a plain test. The loop around it is `code: src/engine.ts#drive`.

## Bundling for hosting

Today `infra/local/docker-compose.yml` runs the model proxy, its database, the egress proxy and the Ollama relay. The runner and the studio run as node processes on the host.

The planned bundle uses one compose file with three parts:

- The runner has access to the docker socket on its host because it starts the sandboxes.
- The proxy is LiteLLM with its database. It holds keys and spend logs.
- The studio only reads the data dir and needs nothing else.

The sandbox network and egress proxy sit beside them, as in `infra/local/docker-compose.yml`. The data dir is a volume shared by runner and studio.

The studio is optional. It can run anywhere that mounts the data dir read-only. The proxy can be one that already runs, since the engine needs only `BOTHUB_PROXY_URL` and the per-agent keys.

The runner cannot be split from docker, because a run is a container the runner starts. The GitHub side needs only the App credentials, which stay with the runner.
