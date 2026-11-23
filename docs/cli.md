# CLI

After [installation](local.md), run commands in your checkout or [select a named instance](local.md#named-instances-and-settings). `agi <verb> --help` lists the flags for a command. `--version` prints the version. Unknown or misplaced flags exit with code 2. See [Terms](index.md#terms) for the names used below. <!-- code: src/cli.ts#readArgs src/instance.ts#readPickedInstance -->

Outside a repository, `show` lists instances and `check --dir <dir>` validates a graph. <!-- code: bin/run.ts#runOnInstance bin/run.ts#checkGraph -->

## Verbs

Issue and pull request numbers both work as handles. <!-- code: src/instance.ts#findPull -->

| Command | Action |
| --- | --- |
| `start "<text>"` | File an issue and drive it. The first line becomes its title. <!-- code: src/main.ts#writeTriggeringIssue --> |
| `say <n> "<text>"` | Post text and drive the issue. A leading colon selects a [command](workflows.md#commands). <!-- code: src/tracker.ts#formatAgentComment --> |
| `review <n> approve` | Approve the pull request. |
| `review <n> changes "<why>"` | Request changes with prior line comments, then drive the issue. |
| `merge <n>` | Fast-forward the instance base, close the issue and export the branch. |
| `export <n>` | Export the branch again. |
| `close <n>` | Close the issue and its open pull request. A live run stops when it next checks. |
| `show [n]`, `show graph` | Show runs that need attention, one issue's timeline and diff, or the graph. |
| `studio` | Serve one instance in the [studio](local.md#the-studio) and print its URL. |
| `loop`, `stop`, `restart` | [Run or control the loop](local.md#the-loop) for the selected checkouts. |
| `check` | Validate the graph without starting models or containers. |
| `check <name>... --runs` | Run [checks on ended runs](checks.md#end-checks). |
| `resume <run id>`, `resume --parked` | Queue one run or all runs waiting after engine errors. |
| `dispatch <n> ["<text>"]` | Start the selected `--workflow` with [request text](workflows.md#dispatch). |
| `prune-logs` | Inspect or clean up [check logs](runs.md#check-logs). |
| `label <run id> [k=v\|k-]...` | Set or remove [run labels](runs.md#run-labels), then print them. A path of the form `<store>/<run>` works without an instance. |
| `import <commit>\|<patch> [<issue file>]` | [Import a change](runs.md#imported-runs) and print the run ID. |

<!-- code: bin/run.ts bin/run.ts#runOnInstance bin/run.ts#openStudio src/instance.ts#mergePull src/labels.ts#parseLabelPatch -->

A resumed run continues on the [next loop pass](local.md#the-loop). <!-- code: src/run/trigger.ts#instruct -->

Hosted trackers refuse `start`, `say`, `review`, `merge`, `close` and `export`. Use the tracker's UI. See [local driving](local.md#who-drives). <!-- code: bin/run.ts#runOnInstance -->

## Flags

| Flag | Commands | Meaning |
| --- | --- | --- |
| `--instance <name>` | all (repeat for `loop`, `stop`, `restart`) | Saved instance |
| `--data <dir>` | all | Data root |
| `--repo <dir>` | all | Checkout |
| `--base <branch>` | all | Base branch |
| `--dir <dir>` | all | [Graph](reference.md#which-graph-runs) |
| `--tracker <name-or-dir>` | all | Plugin, including `github`, or tracker folder |
| `--runner <name>` | all | [Runner](sandbox.md#runners) (default `local`) |
| `--logs all\|failed\|off` | all | Retained check output |
| `--provider <name>` | all | Provider |
| `--save` | with `--provider` | Save choice |
| `--harness <name>` | all | Override every agent's harness |
| `--model <model>` | all | Override every agent's model |
| `--label <label>` | `start`, `say` | Repeatable issue label |
| `--run-label <key>=<value>` | `start` | Repeatable run label |
| `--workflow <name>` | `start`, `dispatch`, `check --runs` | Workflow |
| `--step <step>` | `dispatch` | Starting step |
| `--issue <n>` | `check --runs` | Issue filter |
| `--parked` | `resume` | All runs parked by engine errors |
| `--runs` | `check` | Ended runs |
| `--line <path>:<line>` | `say` | Pull request line comment |
| `--as <branch>` | `export` | Another `agentgraph/` branch |
| `--patch <file>` | `export` | Write a patch to a new file |
| `--read-only` | all | Prevent writes to the checkout on this and later commands. Use `export <n> --patch <file>` to retrieve changes. |
| `--once` | `loop` | One pass |
| `--detach` | `loop` | Start a [background loop](local.md#the-loop) |
| `--force` | `stop`, `restart` | Force a [loop stop](local.md#the-loop) |
| `--parallel <n>` | `loop`, `restart` | Cap sandbox commands across instances alongside `limits.parallel` in a continuous loop |
| `--apply` | `prune-logs` | Remove [unreferenced check logs](runs.md#check-logs) |
| `--from <commit>` | `import` | Starting commit (default parent, or `HEAD` for patches) |
| `--meta <file>` | `import` | JSON for `meta.engine.origin.input` |
| `--plugins <dir>` | `studio` | Add [studio pages](plugins.md#studio-pages) |

<!-- code: src/cli.ts#readArgs bin/run.ts src/instance.ts#ensureInstance -->

Printed commands include `--repo`, `--data`, `--instance`. Inside repositories, `check --dir` validates against the saved provider. <!-- code: src/cli.ts#readArgs src/status.ts#formatInstanceFlags bin/run.ts#checkGraph -->

## Picking a provider

The CLI selects a [provider](sandbox.md#providers) from `--provider`, the instance env file, `instance.yaml`, then the shell. Without a selection, it saves the only ready provider or asks you to choose. Unavailable providers and unsupported harnesses fail before filing an issue. `--save` retains an explicit choice. <!-- code: bin/run.ts#pickProvider -->

## Environment

Set the data root with `--data` or `AGENTGRAPH_DATA` in the shell. After selecting an instance, the engine sets `AGENTGRAPH_DATA` to its data folder and `AGENTGRAPH_TRACKER_DIR` to its tracker folder, overriding values in the env file. See [instance settings](local.md#named-instances-and-settings). <!-- code: src/services.ts#readHostSettings src/main.ts#readInstanceEnv -->

| Variables | Reference |
| --- | --- |
| `AGENTGRAPH_APP_ENV`, `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_APP_KEY_FILE` | [App credentials](github.md#the-key) |
| `AGENTGRAPH_TRACKER`, `AGENTGRAPH_REPO`, `AGENTGRAPH_TRUST` | [Instance settings](local.md#named-instances-and-settings) |
| `AGENTGRAPH_DIR` | [Graph selection](reference.md#which-graph-runs) |
| `AGENTGRAPH_STATE` | [Host state](sandbox.md#environments) |
| `AGENTGRAPH_EVERY` | [Loop polling](local.md#the-loop) |
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

<!-- code: src/services.ts#hostSettings src/services.ts#settings src/main.ts#readInstanceEnv src/harnesses.ts#readHarnessSettings src/run/check.ts#makeScriptEnv -->

See also [script variables](checks.md#script-variables), [disk settings](sandbox.md#disk) and [studio auth](plugins.md#auth).
