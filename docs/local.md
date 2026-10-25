# Running it locally

You need Node 22.18 or later, Docker and `jq`. Commands run from `agentgraph/`.

## The model stack

```sh
cp infra/local/.env.example infra/local/.env   # once: set LITELLM_MASTER_KEY and provider keys
npm run up                                     # sandbox image, proxy and egress, waits until healthy
npm run keys                                   # one proxy key per agent, in infra/local/.keys.env
```

Runs need the stack up. `npm run down` stops it and keeps its volumes.

[Local infrastructure](../infra/local/README.md) covers providers, the ChatGPT login for `smart` and moving a stack from the old `bothub` compose project.

## The CLI

```sh
npx agentgraph check --hub examples/sandbox
npx agentgraph --hub examples/sandbox --issue 3 --data ~/agentgraph-data
npx agentgraph start --instance ~/agentgraph/kit --workflow issue "Reject a negative count"
npx agentgraph --hub examples/sandbox --all --data ~/agentgraph-data
npx agentgraph loop --hub examples/sandbox --data ~/agentgraph-data
npx agentgraph status --hub examples/sandbox --data ~/agentgraph-data
npx agentgraph prune-logs --data ~/agentgraph-data [--apply]
```

| Command | What it does |
| --- | --- |
| `check` | Validates a hub and prints each problem with its file, or `ok`. Needs no model or container. |
| `--issue <n>` | Starts or resumes one issue's run and drives it until it waits or ends. |
| `start "<text>"` | Files the text as a new issue in the [forge folder](forge.md#dropped-issue-files) and runs it like `--issue`. The first line is the title, the rest the body. The issue gets the label of `--workflow`, which may be left out when only one workflow has a label. The author is the instance owner or `git config user.name` and must be trusted. <!-- code: src/main.ts#writeTriggeringIssue --> |
| `--all` | One pass over open issues. Starts runs only on trusted commands or labels, up to `limits.parallel` at once. |
| `loop` | A pass at startup, then every `AGENTGRAPH_EVERY` minutes. Without `--hub` it uses the repo's [own hub](loop.md#a-hub-in-the-repo) and `AGENTGRAPH_REPO`. |
| `status` | Lists human waits and the commands to continue them. On GitHub it needs App credentials and warns when the App reaches other repos. |
| `prune-logs` | Counts [check logs](runs.md#check-logs) no trace names; `--apply` deletes them. |

`--hub`, `--data` and `--forge` select folders. `--forge` replaces GitHub with a [forge folder](forge.md). `--instance` supplies all three. Outside an instance, every command but `check` needs `--data`. Keep data out of temporary directories, since macOS deletes untouched files there after three days; startup warns about it. <!-- code: src/main.ts#start src/main.ts#temporary -->

Three commands talk to a run the way [router proposals](loop.md#routing) do:

```sh
npx agentgraph say --hub <dir> --data <dir> --issue <n> [--comment <review comment id>] "<text>"
npx agentgraph tell --data <dir> --issue <n> "<text>"
npx agentgraph dispatch --hub <dir> --data <dir> --workflow <name> --issue <n> [--step <step>]
```

`say` runs the router now and replies where the text came from. `tell` queues text for a live run and refuses when there is none. `dispatch` starts a workflow that accepts `dispatch`.

### Settings

The runner reads these from the environment. The CLI sets `AGENTGRAPH_HUB`, `AGENTGRAPH_DATA`, `AGENTGRAPH_FORGE` and `AGENTGRAPH_REPO` (the hub's `repo`) from its flags. <!-- code: src/services.ts#settings -->

| Variable | Meaning and default |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Env file with `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE` |
| `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY` | The App id and private key, when set directly instead |
| `AGENTGRAPH_APP_KEY_FILE` | File holding the App's private key, read once per start; `/dev/fd/3` reads it from the [Keychain](../infra/github/README.md#create-the-app) |
| `AGENTGRAPH_EVERY` | Poll interval in minutes, 5 |
| `AGENTGRAPH_PROXY_URL` | Model proxy, `http://litellm:4000/v1` |
| `AGENTGRAPH_PROXY_KEYS` | Per-agent keys, see [Models](sandbox.md#models); `AGENTGRAPH_PROXY_KEYS_FILE` names a file holding them |
| `AGENTGRAPH_PRICES` | List prices, `infra/local/prices.json` |
| `AGENTGRAPH_CONFIG` | The [harness plugins](sandbox.md#harnesses) file, `agentgraph.config.ts` |
| `AGENTGRAPH_CHECK_LOGS` | `all`, `failed` or `off`, also set by `--logs`; see [Check logs](runs.md#check-logs) |
| `AGENTGRAPH_CACHE_VOLUME` | [Toolchain cache](sandbox.md#toolchains) volume, `agentgraph-cache` |
| `AGENTGRAPH_IMAGE` | Base image when the hub sets none, `agentgraph-sandbox:local` |
| `AGENTGRAPH_SANDBOX_URL` | Box server that runs commands instead of docker, see [Cloudflare](cloudflare.md); empty for docker |
| `AGENTGRAPH_STUDIO_URL` | Studio address for [run links](runs.md#run-links) |

A setting found in several places takes the last of: an instance's `keys.env`, the shell, the App env file. Only the two key settings accept a `_FILE` form, and only the winning source's file is read. [Secrets on the host](sandbox.md#secrets-on-the-host) covers what else keeps keys contained. <!-- code: src/main.ts#readEngineEnv -->

Disk and cache limits are in [Environments](sandbox.md#environments).

## On GitHub

Create the App with `node bin/setup-app.ts` ([App setup](../infra/github/README.md)) and point `AGENTGRAPH_APP_ENV` at its `app.env`. Then prepare a data directory:

```sh
infra/local/e2e.sh ~/agentgraph-data examples/sandbox
```

It writes the agent keys as `AGENTGRAPH_PROXY_KEYS` to `~/agentgraph-data/.env` and prints the commands to run. The runner does not load that file, so source it first.

## The studio

From `studio/`:

```sh
npm install
npm run dev -- --instance ~/agentgraph/kit
```

It serves on port 5182, or `AGI_PORT`; give each instance its own port. Instead of `--instance`, `--hub <dir> --data <dir>` select the inputs; add `--forge <dir>` so the Inbox names forge commands. Without either it reads `examples/sandbox` and `AGENTGRAPH_DATA`, else `~/.agentgraph`. `npm run dev -- --bench <dirs>` fills the [Bench](bench.md#cost-against-quality) tab, and `npm run dev -- --tune <dir>` the Compound tab. The studio only reads. Its Inbox lists the runs that wait for a person, with the same commands `status` prints. A run that waits on a run it started is left out. <!-- code: studio/src/runs/InboxPage.tsx#InboxPage src/status.ts#findRunsWaitingOnPeople -->
