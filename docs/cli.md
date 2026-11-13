# CLI

See [installation](local.md). `agi <verb> --help` lists flags; `--version` prints the version. Unknown or misplaced flags fail with exit code 2. <!-- code: src/cli.ts#readArgs -->

[Select an instance](local.md#named-instances-and-settings). <!-- code: src/instance.ts#readPickedInstance -->

Outside a repository, `show` lists instances and `check --dir <dir>` validates a graph. <!-- code: bin/run.ts#runOnInstance bin/run.ts#checkGraph -->

## Verbs

Issue and pull request numbers both work as handles. <!-- code: src/instance.ts#findPull -->

| Command | Action |
| --- | --- |
| `start "<text>"` | File an issue and drive it. The first line becomes its title. <!-- code: src/main.ts#writeTriggeringIssue --> |
| `say <n> "<text>"` | Post text and drive the issue. A leading colon selects a [command](workflows.md#commands). <!-- code: src/tracker.ts#formatAgentComment --> |
| `review <n> approve` | Approve pull request. |
| `review <n> changes "<why>"` | Request changes with prior line comments, then drive the issue. |
| `merge <n>` | Fast-forward base, close issue, export branch. <!-- code: src/instance.ts#mergePull --> |
| `export <n>` | Export branch again. |
| `close <n>` | Close the issue and its open pull request. A live run stops when it next checks. |
| `show [n]`, `show graph` | Show what needs you, an issue's timeline and diff, or the graph. |
| `studio` | Start [studio](local.md#the-studio); print URL. |
| `loop` | Drive issues; poll events. |
| `stop` | Stop loops and wait for them to release their checkouts. |
| `restart` | Stop loops; start with `--detach`. |
| `check` | Validate graph without models or containers. |
| `check <name>... --runs` | [Check ended runs](checks.md#end-checks). |
| `resume <run id>`, `resume --parked` | Queue parked runs. |
| `dispatch <n> ["<text>"]` | Start `--workflow` with [request text](workflows.md#dispatch). |
| `prune-logs` | Count unreferenced [logs](runs.md#check-logs). |
| `label <run id> [k=v\|k-]...` | Set or remove [labels](runs.md#run-labels), then print them. <!-- code: src/labels.ts#parseLabelPatch --> |
| `import <commit>\|<patch> [<issue file>]` | [Import change](runs.md#imported-runs); print ID. |

A loop must drive resumed runs; `loop --once` makes one pass. See [recovery](workflows.md#order-and-limits). <!-- code: src/run/trigger.ts#instruct -->

Hosted trackers refuse `start`, `say`, `review`, `merge`, `close` and `export`. Use the tracker's UI. See [local driving](local.md#who-drives). <!-- code: bin/run.ts#runOnInstance -->

## Flags

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--instance <name>` | all; repeat for `loop` | Saved instance |
| `--data <dir>` | all | Data root |
| `--repo <dir>` | all | Checkout |
| `--base <branch>` | all | Base branch |
| `--dir <dir>` | all | [Graph](reference.md#which-graph-runs) |
| `--tracker <name-or-dir>` | all | Plugin, including `github`, or tracker folder |
| `--runner <name>` | all | [Runner](sandbox.md#runners); default `local` |
| `--logs all\|failed\|off` | all | Retained check output |
| `--provider <name>` | all | Provider |
| `--save` | with `--provider` | Save choice |
| `--harness <name>` | all | Override every agent's harness |
| `--model <model>` | all | Override every agent's model |
| `--label <label>` | `start`, `say` | Issue label; repeatable |
| `--run-label <key>=<value>` | `start` | Run label; repeatable |
| `--workflow <name>` | `start`, `dispatch`, `check --runs` | Workflow |
| `--step <step>` | `dispatch` | Starting step |
| `--issue <n>` | `check --runs` | Issue filter |
| `--parked` | `resume` | All runs parked by engine errors |
| `--runs` | `check` | Ended runs |
| `--line <path>:<line>` | `say` | Pull request line comment |
| `--as <branch>` | `export` | Another `agentgraph/` branch |
| `--patch <file>` | `export` | Patch; file must not exist |
| `--read-only` | all | Persistently prevent repository writes |
| `--once` | `loop` | One pass |
| `--detach` | `loop` | Background; print PID after locking checkouts; logs under `<data root>/logs/` |
| `--force` | `stop`, `restart` | SIGTERM immediately |
| `--parallel <n>` | `loop`, `restart` | Cap drives across instances alongside `limits.parallel`; incompatible with `--once` |
| `--apply` | `prune-logs` | Delete logs |
| `--from <commit>` | `import` | Starting commit; default parent, or `HEAD` for patches |
| `--meta <file>` | `import` | JSON for `meta.engine.origin.input` |
| `--plugins <dir>` | `studio` | Add [pages](plugins.md#studio-pages) across instances |

Printed commands include `--repo`, `--data`, `--instance`. Inside repositories, `check --dir` validates against the saved provider. <!-- code: src/cli.ts#readArgs src/status.ts#formatInstanceFlags bin/run.ts#checkGraph -->

## Picking a provider

The CLI selects a [provider](sandbox.md#providers) from `--provider`, the instance env file, `instance.yaml`, then the shell. Without a selection, it saves the only ready provider or asks you to choose. Unavailable providers and unsupported harnesses fail before filing an issue. `--save` retains an explicit choice. <!-- code: bin/run.ts#pickProvider -->

## Environment

See [settings precedence](local.md#named-instances-and-settings). Variables link to their behavior:

| Variables | Reference |
| --- | --- |
| `AGENTGRAPH_APP_ENV`, `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_APP_KEY_FILE` | [App credentials](github.md#the-key) |
| `AGENTGRAPH_DATA`, `AGENTGRAPH_TRACKER`, `AGENTGRAPH_TRACKER_DIR`, `AGENTGRAPH_REPO`, `AGENTGRAPH_TRUST` | [Instance settings](local.md#named-instances-and-settings) |
| `AGENTGRAPH_DIR` | [Graph selection](reference.md#which-graph-runs) |
| `AGENTGRAPH_STATE` | [Host state](sandbox.md#environments) |
| `AGENTGRAPH_EVERY` | [Loop polling](local.md#starting-and-stopping-a-loop) |
| `AGENTGRAPH_COMPRESS_DAYS` | [Compression](runs.md#the-data-folder) |
| `AGENTGRAPH_PROVIDER` | [Provider selection](#picking-a-provider) |
| `AGENTGRAPH_HARNESS`, `AGENTGRAPH_CONFIG` | [Harnesses](sandbox.md#harnesses) |
| `AGENTGRAPH_MODELS`, `AGENTGRAPH_PROXY_URL`, `AGENTGRAPH_PROXY_KEYS`, `AGENTGRAPH_SESSION_ENV`, `AGENTGRAPH_PRICES` | [Model settings](sandbox.md#settings) |
| `AGENTGRAPH_CHECK_LOGS` | [Check logs](runs.md#check-logs) |
| `AGENTGRAPH_CACHE_VOLUME` | [Toolchains](sandbox.md#toolchains) |
| `AGENTGRAPH_IMAGE` | [Images](sandbox.md#a-graphs-own-image) |
| `AGENTGRAPH_RUNNER` | [Runners](sandbox.md#runners) |
| `AGENTGRAPH_SANDBOX_URL` | [Hosting](hosting.md) |
| `AGENTGRAPH_STUDIO_URL` | [Run links](runs.md#run-links) |
| `AGENTGRAPH_GITHUB_TOKEN`, `AGENTGRAPH_GITHUB_TOKEN_FILE` | [Fork user credentials](github.md#working-from-a-fork) |
| `AGENTGRAPH_FORK` | [Working from a fork](github.md#working-from-a-fork) |

Other settings: [script variables](checks.md#script-variables), [disk](sandbox.md#disk), [studio auth](plugins.md#auth).
