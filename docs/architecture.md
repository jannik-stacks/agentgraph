# Architecture

Where everything lives, how a run moves, and what is code versus judgement. In this page, "the engine"
is the runner's own code in `core/src`, and "v2" is the current version of it.

## Where everything lives

```
 GitHub (issues, comments, pull requests)
    ^  | events, read through the App
    |  v
 +------------------- host -------------------------------------+
 |  runner process = the engine         code: core/src/main.ts#start
 |   - looks at the repo, begins and drives runs                |
 |   - pushes and opens pull requests (host git, App token)     |
 |   |                          |                               |
 |   | docker run --rm          | reads and writes              |
 |   v                          v                               |
 |  +--------- sandbox ------+  +------ data dir -----------+   |
 |  | one harness session    |  | <run id>/run.json         |   |
 |  | /work: git worktree    |  | <run id>/trace.jsonl      |   |
 |  | no GitHub token        |  | mirror.git, work/, homes/ |   |
 |  +----------+-------------+  | news/<id>/news.md, what a |   |
 |             | model calls    |   session has not read yet|   |
 |             v                +-------------^-------------+   |
 |  +--- LiteLLM proxy ----+                  |                 |
 |  | aliases, one key per |            studio reads only      |
 |  | agent, spend logs    |            run.json and trace     |
 |  +----------+-----------+                                    |
 +-------------|------------------------------------------------+
               v
         model providers
```

The engine is the only part that holds a GitHub token. A sandbox gets its own agent's proxy key and
nothing else, and its network reaches only the proxy and an allowlisting egress proxy. Each session
works in its own worktree of the bare mirror, which is mounted read-only. See [Sandbox](sandbox.md)
and [Runs](runs.md).

The engine talks to its surroundings through four services, each with a test double. The code is
`code: core/src/forge.ts#Forge`, `code: core/src/store.ts#Store`, `code: core/src/sandbox.ts#Sandbox`
and `code: core/src/session.ts#Session`.

## One run through the state machine

```
 trusted event (command or label)
        |
        v
 +--------------+   pass    +--------------+   pass    +-----------+
 |  step A      |---------->|  step B      |---------->| wait:     |--> done
 |  doer session|           |  reviewer    |           | human     |
 +------+-------+           +------+-------+           +-----+-----+
        | try ends                 | until does not hold     | asks for changes
        v                          | (back, rounds cap)      |
 script checks, all at once        +-----> back to step A    +-----> back to step A
        | block failed? feedback
        v                          tries cap spent, rounds cap spent, ask,
 agent checks (PASS or FAIL)       or a session over its minutes
        | failed? feedback             |
        v                              v
 same session, next try          run waits (comment on the issue) or stops
        | all pass
        v
 proposals applied by the engine (push, pull request, comment)
```

Which part is which:

| Deterministic engine code                                              | LLM judgement                                  |
| ---------------------------------------------------------------------- | ---------------------------------------------- |
| Transitions between steps: `code: core/src/workflow.ts#transition`     | The doer session: what it writes and proposes  |
| The tries cap and the rounds cap                                       | An agent-judged check: the reply is PASS or FAIL |
| Script checks and their modes (`warn`, `block`, `stop`)                | Whether the `until` sentence holds             |
| Which proposals are accepted and applied: `code: core/src/engine.ts#land` | What the agent asks a human                 |
| Push safety: a push uses a lease and only the host holds the token     |                                                |
| Triggers and trust: only a collaborator's command or label starts a run, `code: core/src/forge.ts#matches` |                |

The judgement never moves a run by itself. An agent only proposes, a check only answers pass or fail,
and the engine reads those answers and decides where the run goes. A reply that does not parse fails
the try. `transition` is pure, so every path above is a plain test. The loop around it is
`code: core/src/engine.ts#drive`.

## Bundling for hosting

Today `infra/local/docker-compose.yml` runs the proxy, its database and the egress proxy, while the
runner and the studio run as node processes on the host. The planned bundle is one compose file
with three parts:

- the runner, with access to the docker socket on its host, because it starts the sandboxes,
- the proxy, LiteLLM with its database, which holds the keys and the spend logs,
- the studio, which only reads the data dir and needs no other access.

The sandbox network and the egress proxy sit beside them, as in `infra/local/docker-compose.yml`.
The data dir is a volume shared by the runner and the studio.

What is separable. The studio is optional and can run anywhere that mounts the data dir read-only.
The proxy can be one that is already running, since the engine needs only `BOTHUB_PROXY_URL` and the
per-agent keys. The runner cannot be split from docker, because a run is a container the runner starts.
The GitHub side needs only the App credentials, which stay with the runner.
