# CLI

Install it with `npm install -g @jannik-stacks/agi`, or run `npx @jannik-stacks/agi <verb>`. It needs Node 24 and Docker. `--help` prints the usage and `--version` the version; `agi <verb> --help` shows the flags that verb takes. A flag the verb does not take is an error (exit 2), and so is a verb's own flag put before the verb: write `agi start --workflow w text`, not `agi --workflow w start text`. Switches such as `--once` and `--read-only` take no value, so the word after them stays an argument.

Inside a git repo, `agi <verb>` works on a local instance of it: a folder that stands in for GitHub, plus the runs. Your repo only gets `agentgraph/<n>` branches. With `--tracker` or App credentials in the environment, `agi` runs as a runner instead: `--dir` names the graph and `--data` the runs folder.

## Verbs

The issue number is the handle; a pull request's own number works too. <!-- code: src/instance.ts#findPull -->

| Verb | What it does | As a runner |
| --- | --- | --- |
| `start "<text>"` | Files the text as an issue and drives it. The first line is the title. <!-- code: src/main.ts#writeTriggeringIssue --> | |
| `say <n> "<text>"` | Comments `/agent <text>` on issue n and drives it: an answer or feedback. Text that starts with a colon is a [command](workflows.md#commands): `say 12 ":restart:implement"` comments `/agent:restart:implement` <!-- code: src/tracker.ts#formatAgentComment --> | |
| `review <n> approve` | Approves the pull request of issue n | |
| `review <n> changes "<why>"` | Requests changes, with any line comments made before, and drives the issue | |
| `merge <n>` | Moves the base to the pull request's head, retargets stacked pull requests, closes the issue and writes the branch into your repo; fails if the base moved past it <!-- code: src/instance.ts#mergePull --> | |
| `export <n>` | Writes the branch into your repo again | |
| `close <n>` | Closes the issue and its open pull request; a live run stops on its next look | |
| `show [n]`, `show graph` | What needs you, one issue's timeline and diff, or the graph in use; outside a repo, every instance | yes |
| `studio` | Starts the [studio](local.md#the-studio) for this repo and prints its URL | |
| `loop` | Drives open issues in the background and polls new tracker events every `AGENTGRAPH_EVERY` minutes, including during a full pass | yes |
| `check` | Validates a graph without a model or container; prints each problem or `ok` | yes |
| `check <name>... --runs` | Runs the named checks on ended runs; see [Checks](checks.md#end-checks) | yes |
| `resume <run id>` or `resume --parked` | Queues one or all runs parked by a runner error for the next loop pass | yes |
| `dispatch <n> ["<text>"]` | Starts any `--workflow` on issue n, with the text as what it was [asked](workflows.md#dispatch) | yes |
| `prune-logs` | Counts [check logs](runs.md#check-logs) no trace names | yes |
| `label <run id> [k=v\|k-]...` | Sets or removes [run labels](runs.md#run-labels), then prints them <!-- code: src/labels.ts#parseLabelPatch --> | yes |
| `import <commit>\|<patch> [<issue file>]` | Keeps a change made elsewhere as an [imported run](runs.md#imported-runs) and prints its ID | |

`resume` keeps the run ID, step, saved files, sessions and feedback. It clears the runner error and records a retry locally; it posts no comment. Human questions, cancelled runs and ended runs are excluded. A running `loop` picks it up on its next pass; `loop --once` makes one pass. Retros remain quiet when they run again. As a GitHub runner, use the same graph and runs folder as the loop:

```sh
agi resume --parked --tracker github --dir <graph> --data <runs>
agi resume <run-id> --tracker github --dir <graph> --data <runs>
```

<!-- code: src/run/trigger.ts#instruct -->

Only `start`, `say` and `review changes` drive; see [Who drives](local.md#who-drives).

## Flags

| Flag | Used by | Meaning |
| --- | --- | --- |
| `--data <dir>` | all | Data root, default `~/.agentgraph`; as a runner, the runs folder |
| `--repo <dir>` | all | The repo, when not the current directory |
| `--base <branch>` | all | The instance's base branch |
| `--dir <dir>` | all | The graph folder; see [Which graph runs](reference.md#which-graph-runs) |
| `--tracker <name>` or `<dir>` | all | Run as a runner on the tracker plugin `<name>`, such as `github`, or on a tracker folder |
| `--logs all\|failed\|off` | all | Which check output to keep |
| `--provider <name>` | all | The provider for this command |
| `--save` | with `--provider` | Keep that provider for later commands |
| `--harness <name>` | all | Run every agent on this harness, this command only |
| `--model <model>` | all | Give every agent this model, this command only |
| `--label <label>` | `start`, `say` | Add a label to the issue; repeatable |
| `--run-label <key>=<value>` | `start` | Put a [run label](runs.md#run-labels) on the run it begins; repeatable |
| `--workflow <name>` | `start`, `dispatch`, `check --runs` | Which workflow |
| `--step <step>` | `dispatch` | The step to start at |
| `--issue <n>` | `check --runs` | Only runs on this issue |
| `--parked` | `resume` | Resume all runs waiting after a runner error |
| `--runs` | `check` | Run checks on ended runs |
| `--line <path>:<line>` | `say` | Comment on a line of the pull request |
| `--as <branch>` | `export` | Write under another `agentgraph/` branch name |
| `--patch <file>` | `export` | Write a patch file instead; it must not exist yet |
| `--read-only` | all | Never write to this repo from now on, kept in `instance.yaml` |
| `--once` | `loop` | Make one pass |
| `--apply` | `prune-logs` | Delete the logs |
| `--from <commit>` | `import` | The commit the change is measured from; default the commit's parent, or `HEAD` for a patch |
| `--meta <file>` | `import` | JSON kept as the run's `meta.engine.origin.input` |

Printed commands carry the `--repo` and `--data` given. Inside a repo, `check --dir` checks against the instance's saved provider. <!-- code: src/services.ts#settings -->

## Picking a provider

A provider is where model calls go and how they log in; [Sandbox and models](sandbox.md#providers) lists them. The CLI takes `--provider`, then `provider` in `instance.yaml`, then `AGENTGRAPH_PROVIDER`, then the only ready one, which it saves. It picks before it sets up Docker, so a missing model fails before the image build. With several ready it asks, or fails without a terminal. With none, or an agent whose harness the provider does not serve, it says why and files nothing. <!-- code: bin/run.ts#pickProvider -->

## Examples

```sh
agi say 1 "also cover a negative len"
agi start --provider anthropic --save "Add a greet function"
agi loop --tracker github --dir .agentgraph --data ~/agentgraph-data
```

The shared `--instance <name>` flag chooses the named instance. See the [settings table](local.md#named-instances-and-settings).

## Environment

The runner reads these. Instance defaults and command overrides follow the [settings table](local.md#named-instances-and-settings). <!-- code: src/services.ts#settings -->

| Variable | Meaning and default |
| --- | --- |
| `AGENTGRAPH_APP_ENV` | Env file with `AGENTGRAPH_APP_ID` and `AGENTGRAPH_APP_KEY_FILE`; see [Running on GitHub](github.md) |
| `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY` | The App id and private key, set directly |
| `AGENTGRAPH_APP_KEY_FILE` | File with the App key; `/dev/fd/3` reads it from the Keychain |
| `AGENTGRAPH_DATA` | Data root, `~/.agentgraph`; `--data` wins |
| `AGENTGRAPH_EVERY` | Poll interval in minutes, 5 |
| `AGENTGRAPH_COMPRESS_DAYS` | Days after which `loop` compresses an untouched ended run's trace and check record with zstd, 14; 0 never |
| `AGENTGRAPH_TRACKER_DIR` | The folder a tracker plugin picked by name keeps its files in; a local instance sets its `tracker/` |
| `AGENTGRAPH_REPO` | Tracker repository override of instance `repo` |
| `AGENTGRAPH_TRUST` | Comma-separated logins overriding instance trust |
| `AGENTGRAPH_PROVIDER` | The provider; agents that name no harness get its first |
| `AGENTGRAPH_HARNESS` | The harness every agent runs on |
| `AGENTGRAPH_MODELS` | `alias=model` pairs, `*` for agents without a `model` |
| `AGENTGRAPH_PROXY_URL` | Model gateway, `http://gateway:4000/v1`; see [Models](sandbox.md#models) |
| `AGENTGRAPH_PROXY_KEYS` | Per-agent keys, `agent=key` pairs |
| `AGENTGRAPH_SESSION_ENV` | Model login variables every session gets; see [Sandbox settings](sandbox.md#settings) |
| `AGENTGRAPH_PRICES` | List prices, `infra/local/prices.json.gz` |
| `AGENTGRAPH_CONFIG` | The [harness plugins](sandbox.md#harnesses) file, `config.ts` in the data root, else `agentgraph.config.ts` |
| `AGENTGRAPH_CHECK_LOGS` | `all`, `failed` or `off`, as `--logs` |
| `AGENTGRAPH_CACHE_VOLUME` | Name prefix of the per-repo [toolchain cache](sandbox.md#toolchains) volumes, `agentgraph-cache` |
| `AGENTGRAPH_IMAGE` | Sandbox image override; default `agentgraph-sandbox:local` |
| `AGENTGRAPH_SANDBOX_URL` | A box server that runs commands instead of docker; see [Hosting](hosting.md) |
| `AGENTGRAPH_STUDIO_URL` | Studio address for [run links](runs.md#run-links) |

A setting in both the shell and the App env file takes the env file's value. Only `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_PROXY_KEYS` and the names in `AGENTGRAPH_SESSION_ENV` may come from a file named by the setting plus `_FILE`. <!-- code: src/main.ts#readEngineEnv -->

Script variables are in [Checks](checks.md#script-variables), and disk settings in [Sandbox and models](sandbox.md#disk).
