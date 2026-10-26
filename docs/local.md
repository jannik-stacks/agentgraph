# Running it locally

You need Node 24 or later and Docker, used as a user in the `docker` group. The model stack and the studio run from a clone of agentgraph, and `npm run keys` also needs `jq`.

## The model stack

```sh
cp infra/local/.env.example infra/local/.env   # once: set LITELLM_MASTER_KEY and provider keys
npm run up                                     # proxy and egress, waits until healthy
npm run keys -- local                          # one proxy key for every agent, in infra/local/.keys.env.local
```

Only `--provider litellm` needs the stack; the `anthropic` and `claude` providers call their API directly. Load the key with `set -a; . infra/local/.keys.env.local; set +a`. `npm run down` stops the stack and keeps its volumes.

[Local infrastructure](../infra/local/README.md) covers providers and the ChatGPT login for `smart`.

## The CLI

`agi <verb>`, or `npx @jannik-stacks/agi <verb>` without installing, inside a git repo runs that repo on a [local forge](forge.md), with no setup and no GitHub. `start`, `say`, `review`, `merge`, `export`, `close`, `show` and `loop` are in [Verbs](forge.md#verbs). `--help` prints the usage and `--version` the version.

| Command | What it does |
| --- | --- |
| `check` | Validates a graph and prints each problem with its file, or `ok`. Needs no model or container. |
| `check <name>... --runs` | Runs the named checks on ended runs, narrowed by `--workflow` and `--issue`; see [At run end and later](loop.md#at-run-end-and-later). |
| `dispatch <n>` | Starts the workflow `--workflow` on issue `n`, at `--step` when given, when it accepts `dispatch`. |
| `prune-logs` | Counts [check logs](runs.md#check-logs) no trace names; `--apply` deletes them. |

Keep data out of temporary directories, since macOS deletes untouched files there after three days; startup warns about it. <!-- code: src/main.ts#start src/main.ts#temporary -->

### On a forge

`--forge github`, `--forge <dir>` or App credentials in the environment run the CLI as a runner instead: no instance, `--dir` names the graph, and `--data` is the runs folder itself. Its verbs are `loop` (with `--once` for one pass), `show`, `check`, `dispatch` and `prune-logs`.

```sh
agi loop --forge github --dir examples/sandbox --data ~/agentgraph-data
agi show --forge github --dir examples/sandbox --data ~/agentgraph-data
```

`loop` without `--dir` uses the repo's [own graph](loop.md#a-graph-in-the-repo) and `AGENTGRAPH_REPO`. On GitHub `show` needs App credentials and warns when the App reaches other repos.

### Settings

The runner reads these from the environment. The CLI sets `AGENTGRAPH_DIR`, `AGENTGRAPH_DATA`, `AGENTGRAPH_FORGE` and `AGENTGRAPH_REPO` (the graph's `repo`, unless the environment already names one) from its flags, and `AGENTGRAPH_TRUST` to the instance owner. <!-- code: src/services.ts#settings -->

| Variable | Meaning and default |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Env file with `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE` |
| `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY` | The App id and private key, when set directly instead |
| `AGENTGRAPH_APP_KEY_FILE` | File holding the App's private key, read once per start; `/dev/fd/3` reads it from the [Keychain](../infra/github/README.md#create-the-app) |
| `AGENTGRAPH_DATA` | The data root of instances, `~/.agentgraph`, or the runs folder when the CLI runs [on a forge](#on-a-forge); `--data` wins |
| `AGENTGRAPH_EVERY` | Poll interval in minutes, 5 |
| `AGENTGRAPH_HARNESS` | The harness every agent runs on, whatever the graph names |
| `AGENTGRAPH_PROVIDER` | A provider from the config; agents that name no harness get its first |
| `AGENTGRAPH_MODELS` | `alias=model` pairs, `*` for agents without a `model`; see [Models](sandbox.md#models) |
| `AGENTGRAPH_REPO` | `owner/name` of the repo to work on instead of the graph's `repo`, so a public graph can keep a placeholder |
| `AGENTGRAPH_TRUST` | Comma-separated logins trusted instead of the graph's `trust` |
| `AGENTGRAPH_PROXY_URL` | Model gateway, `http://gateway:4000/v1`, the local LiteLLM's name on the sandbox networks; see [Models](sandbox.md#models) |
| `AGENTGRAPH_PROXY_KEYS` | Per-agent keys, see [Models](sandbox.md#models); `AGENTGRAPH_PROXY_KEYS_FILE` names a file holding them |
| `AGENTGRAPH_SESSION_ENV` | Engine variables every session gets, such as a harness login token; empty by default |
| `AGENTGRAPH_PRICES` | List prices, `infra/local/prices.json.gz` |
| `AGENTGRAPH_CONFIG` | The [harness plugins](sandbox.md#harnesses) file; the CLI uses `config.ts` in the data root when it exists, else the package's `agentgraph.config.ts` |
| `AGENTGRAPH_CHECK_LOGS` | `all`, `failed` or `off`, also set by `--logs`; see [Check logs](runs.md#check-logs) |
| `AGENTGRAPH_CACHE_VOLUME` | [Toolchain cache](sandbox.md#toolchains) volume, `agentgraph-cache` |
| `AGENTGRAPH_IMAGE` | Base image when the graph sets none, `agentgraph-sandbox:local` |
| `AGENTGRAPH_SANDBOX_URL` | Box server that runs commands instead of docker, see [Hosting](hosting.md); empty for docker |
| `AGENTGRAPH_STUDIO_URL` | Studio address for [run links](runs.md#run-links) |

A setting found in both the shell and the App env file takes the App env file's. Only the two key settings and the names in `AGENTGRAPH_SESSION_ENV` accept a `_FILE` form, and only the winning source's file is read. [Secrets on the host](sandbox.md#secrets-on-the-host) covers what else keeps keys contained. <!-- code: src/main.ts#readEngineEnv -->

Disk and cache limits are in [Environments](sandbox.md#environments).

## On GitHub

Create the App with `node bin/setup-app.ts` ([App setup](../infra/github/README.md)) and point `AGENTGRAPH_APP_ENV` at its `app.env`. Then prepare a data directory:

```sh
infra/local/e2e.sh ~/agentgraph-data examples/sandbox
```

It writes the agent keys as `AGENTGRAPH_PROXY_KEYS` to `~/agentgraph-data/.env` and prints the commands to run. The runner does not load that file, so source it first.

## The studio

Inside a repo, `agi studio` starts it for that repo. From `studio/` in a clone:

```sh
npm install
npm run dev -- --repo ~/code/left-pad
```

It serves on port 5182, or `AGI_PORT`; give each repo its own port. `--repo` reads that repo's instance under `--data` or the default data root. Instead, `--dir <dir> --data <dir>` select the inputs; add `--forge <dir>` so the Inbox names local commands. Without either it reads `examples/sandbox` and `AGENTGRAPH_DATA`, else `~/.agentgraph`. `npm run dev -- --bench <dirs>` fills the [Bench](bench.md#cost-against-quality) tab, and `npm run dev -- --tune <dir>` the [Results](runs.md#results) tab's tunes. The studio only reads. Its Inbox lists the runs that wait for a person, with the same commands `show` prints, including the `--repo` and `--data` it was opened with. A run that waits on a run it started is left out. <!-- code: studio/src/runs/InboxPage.tsx#InboxPage src/status.ts#findRunsWaitingOnPeople -->
