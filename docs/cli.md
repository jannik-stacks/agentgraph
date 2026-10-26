# CLI

Install it with `npm install -g @jannik-stacks/agi`. It needs Node 24 and Docker.

`agi <verb>` inside a git repo works on a local instance of that repo: a folder that stands in for GitHub, plus the runs. Your repo only gets `agentgraph/<n>` branches. With `--forge github`, `--forge <dir>` or App credentials in the environment, `agi` runs as a runner instead: there is no instance, `--dir` names the graph and `--data` is the runs folder.

## Verbs

The issue number is the handle. An issue has at most one open pull request, on `agentgraph/<n>`, and a pull request's own number works too. <!-- code: src/instance.ts#findPull -->

| Verb | What it does | As a runner |
| --- | --- | --- |
| `start "<text>"` | Files the text as an issue and drives it. The first line is the title. <!-- code: src/main.ts#writeTriggeringIssue --> | |
| `say <n> "<text>"` | Comments `/agent <text>` on issue n and drives it: an answer, feedback, `stop`, `cancel` or `restart` | |
| `review <n> approve` | Approves the pull request of issue n | |
| `review <n> changes "<why>"` | Requests changes, with any line comments made before, and drives the issue | |
| `merge <n>` | Moves the base to the pull request's head, retargets stacked pull requests, closes the issue and writes the branch into your repo. Fails if the base moved past it. <!-- code: src/instance.ts#mergePull --> | |
| `export <n>` | Writes the branch into your repo again | |
| `close <n>` | Closes the issue and its open pull request; a live run stops on its next look | |
| `show [n]`, `show graph` | What needs you and every issue, one issue's timeline and diff, or the graph in use. Outside a repo it lists every instance. | yes |
| `loop` | Drives every open issue, then again when something changes or every `AGENTGRAPH_EVERY` minutes | yes |
| `check` | Validates a graph and prints each problem with its file, or `ok`. Needs no model or container. | yes |
| `check <name>... --runs` | Runs the named checks on ended runs; see [Checks](checks.md#end-checks) | yes |
| `dispatch <n>` | Starts `--workflow` on issue n, when that workflow accepts `dispatch` | yes |
| `prune-logs` | Counts [check logs](runs.md#check-logs) no trace names | yes |

`start`, `say` and `review changes` drive the issue in the foreground until it waits or ends. The others never drive. See [Install and first run](local.md#who-drives).

## Flags

| Flag | Used by | Meaning |
| --- | --- | --- |
| `--data <dir>` | all | Data root, default `~/.agentgraph`; as a runner, the runs folder |
| `--repo <dir>` | all | The repo, when not the current directory |
| `--base <branch>` | all | The instance's base branch |
| `--dir <dir>` | all | The graph folder; see [Which graph runs](reference.md#which-graph-runs) |
| `--forge github` or `<dir>` | all | Run as a runner on GitHub or on a forge folder |
| `--logs all\|failed\|off` | all | Which check output to keep |
| `--provider <name>` | all | The provider for this command |
| `--save` | with `--provider` | Keep that provider for later commands |
| `--harness <name>` | all | Run every agent on this harness, this command only |
| `--model <model>` | all | Give every agent this model, this command only |
| `--label <label>` | `start`, `say` | Add a label; repeatable. `start` adds the workflow's label itself. |
| `--workflow <name>` | `start`, `dispatch`, `check --runs` | Which workflow |
| `--step <step>` | `dispatch` | The step to start at |
| `--issue <n>` | `check --runs` | Only runs on this issue |
| `--runs` | `check` | Run checks on ended runs |
| `--line <path>:<line>` | `say` | Comment on a line of the pull request |
| `--as <branch>` | `export` | Write under another branch name |
| `--patch <file>` | `export` | Write a patch file instead |
| `--once` | `loop` | Make one pass |
| `--apply` | `prune-logs` | Delete the logs |

The commands the CLI prints carry the `--repo` and `--data` it was given. Inside a repo, `check --dir` checks against the instance's saved provider. <!-- code: src/services.ts#settings -->

## Picking a provider

A provider is where model calls go and how they log in; [Sandbox and models](sandbox.md#providers) lists them. The CLI uses the first it finds: `--provider`, then `provider` in `instance.yaml`, then `AGENTGRAPH_PROVIDER`, then the only ready one, which it saves. If several are ready, it asks and saves the answer; without a terminal it fails. If none is ready, it says how to set one up and files nothing. An agent whose harness the provider does not serve fails before anything is filed. <!-- code: bin/run.ts#pickProvider -->

## Examples

```sh
agi start "padStart drops the last char when len is 0"
agi show
agi say 1 "also cover a negative len"
agi review 1 changes "use a guard clause"
agi merge 1
agi start --provider anthropic --save "Add a greet function"
agi check --dir .agentgraph
agi loop --forge github --dir .agentgraph --data ~/agentgraph-data
```

## Environment

The runner reads these. The CLI sets `AGENTGRAPH_DIR`, `AGENTGRAPH_DATA`, `AGENTGRAPH_FORGE` and `AGENTGRAPH_REPO` from its flags, and `AGENTGRAPH_TRUST` to the instance owner. <!-- code: src/services.ts#settings -->

| Variable | Meaning and default |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Env file with `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE`; see [Running on GitHub](github.md) |
| `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY` | The App id and private key, set directly |
| `AGENTGRAPH_APP_KEY_FILE` | File with the App key, read once per start; `/dev/fd/3` reads it from the Keychain |
| `AGENTGRAPH_DATA` | Data root, `~/.agentgraph`; `--data` wins |
| `AGENTGRAPH_EVERY` | Poll interval in minutes, 5 |
| `AGENTGRAPH_REPO` | `owner/name` to work on instead of the graph's `repo` |
| `AGENTGRAPH_TRUST` | Comma-separated logins trusted instead of the graph's `trust` |
| `AGENTGRAPH_PROVIDER` | The provider; agents that name no harness get its first |
| `AGENTGRAPH_HARNESS` | The harness every agent runs on |
| `AGENTGRAPH_MODELS` | `alias=model` pairs, `*` for agents without a `model` |
| `AGENTGRAPH_PROXY_URL` | Model gateway, `http://gateway:4000/v1`; see [Models](sandbox.md#models) |
| `AGENTGRAPH_PROXY_KEYS` | Per-agent keys, `agent=key` pairs |
| `AGENTGRAPH_SESSION_ENV` | Engine variables every session gets, such as a login token |
| `AGENTGRAPH_PRICES` | List prices, `infra/local/prices.json.gz` |
| `AGENTGRAPH_CONFIG` | The [harness plugins](sandbox.md#harnesses) file; default `config.ts` in the data root, else the package's `agentgraph.config.ts` |
| `AGENTGRAPH_CHECK_LOGS` | `all`, `failed` or `off`, as `--logs` |
| `AGENTGRAPH_CACHE_VOLUME` | [Toolchain cache](sandbox.md#toolchains) volume, `agentgraph-cache` |
| `AGENTGRAPH_IMAGE` | Sandbox image when the graph sets none, `agentgraph-sandbox:local` |
| `AGENTGRAPH_SANDBOX_URL` | A box server that runs commands instead of docker; see [Hosting](hosting.md) |
| `AGENTGRAPH_STUDIO_URL` | Studio address for [run links](runs.md#run-links) |

A setting in both the shell and the App env file takes the env file's value. Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the names in `AGENTGRAPH_SESSION_ENV` may come from a file named by the setting plus `_FILE`. <!-- code: src/main.ts#readEngineEnv -->

Script variables are in [Checks](checks.md#script-variables), and disk settings in [Sandbox and models](sandbox.md#disk).
