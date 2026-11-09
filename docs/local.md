# Install and first run

Install Node 24 and set `git config user.name`. The default local runner also needs Docker without root.

```sh
npm install -g @jannik-stacks/agi
```

`npx @jannik-stacks/agi <verb>` runs it without installing. The unscoped `agentgraph` package on npm is unrelated.

The local runner checks Docker, builds missing images and starts the required networks and egress proxy. Other [runners](sandbox.md#runners) supply their own execution environment. <!-- code: src/docker.ts#ensureDocker -->

## Models

Pick one of these; [Providers](sandbox.md#providers) has the details.

- A Claude subscription: the first `agi` command runs `claude setup-token` and keeps the token.
- A ChatGPT subscription, for codex, opencode and pi: `--provider chatgpt --save` runs `codex login` once and keeps that login. Read [what that exposes](sandbox.md#a-chatgpt-login-in-sessions) first.
- An Anthropic key: `export ANTHROPIC_API_KEY=...`, then `--provider anthropic --save`.
- The local model stack, for ChatGPT, OpenRouter or local models: see [infra/local](../infra/local/README.md), load its key with `set -a; . infra/local/.keys.env.local; set +a`, then `--provider litellm`. Only this provider needs the stack.

## First run

Choose an example graph before starting work. With the global npm install, run this once inside your git repo:

```sh
cp -R "$(npm root -g)/@jannik-stacks/agi/examples/starter" .agentgraph
```

From an agentgraph clone, including when you use `npx`, copy it with `cp -R examples/starter <repo>/.agentgraph` instead. The clone has [other examples](../README.md#examples) too.

Read the copied agents, workflows and checks before running them. The starter implements, tests and reviews a change, then waits for a human merge. Its test check runs the repo's `test` script if it has one. Edit these files for your repo, then start an issue:

```sh
agi start "padStart drops the last char when len is 0"
```

The first command makes a local instance of the repo under `~/.agentgraph`, with a tracker folder that stands in for GitHub. It files the text as issue 1 and drives the starter workflow.

```sh
agi show                                   # what needs you
agi review 1 changes "also cover len 0"    # drives it again
agi merge 1                                # then: git merge agentgraph/1
```

Without a graph, commands that need one stop with a copy command. An `.agentgraph/` that git does not track, such as one in `.git/info/exclude`, is read from disk. With uncommitted changes in a committed `.agentgraph/` and no `--dir`, it says so and runs the committed version; the start banner names the graph, such as `.agentgraph/ at main 1a2b3c4`. <!-- code: src/instance.ts#ensureGraph src/instance.ts#whyGraphUncommitted src/instance.ts#formatGraphName --> Every verb is in the [CLI](cli.md). Keep the data root out of temporary folders, which macOS clears. <!-- code: src/main.ts#start src/main.ts#temporary -->

## Who drives

`start`, `say` and `review changes` drive the issue until it waits or ends. If a loop holds the checkout, they only post and the loop drives it. One loop can serve [several instances](#one-loop-for-several-instances). <!-- code: src/owner.ts#createLoopLock src/owner.ts#readLoopHolder -->

The CLI prints the outcome and next commands; `agi show <n>` includes engine errors and trace paths. Rejected logins stop the run. Ctrl-C interrupts a drive; the next drive resumes it. <!-- code: src/status.ts#formatEngineError src/main.ts#start -->

## Where the result lands

When a drive ends, the branch shows up in your repo as `agentgraph/<n>`, and the CLI prints the diff stat and next commands. Your checkout, index and HEAD never move, and no other branch does. A branch you moved or checked out stays yours, and one you deleted stays deleted until `agi export <n>`; the CLI says how to export under another name. <!-- code: src/instance.ts#writePullToRepo -->

Host git imports objects and updates only the exported branch, without hooks or signing. Engine checkouts live in the instance. <!-- code: src/git.ts#hostGit src/mirror.ts#makeSandbox -->

For a repo agentgraph must not write to at all, pass `--read-only` on first use. Then nothing goes into the repo, and `agi export <n> --patch <file>` hands you the change. <!-- code: src/instance.ts#ensureInstance -->

## The base

The base is the branch checked out on first use, or `origin`'s default on a detached head, else `main`; `--base <branch>` overrides it for one command. Before each drive it fast-forwards to yours. If both moved, the drive stops: merge agentgraph's base into yours and retry. Workflows without a `base` start from it. <!-- code: src/instance.ts#ensureBase src/main.ts#start -->

## The studio

`agi studio` shows the selected instance's graph, runs and results. It needs an engine clone and installs studio dependencies on first use. From the clone you can also run:

```sh
cd studio && npm run dev -- --instance left-pad --instance right-pad
```

The default address is `127.0.0.1:5182`; `AGI_HOST` and `AGI_PORT` override it. Token auth prints a login URL; see [Auth](plugins.md#auth). Changes under `src` or `bin` restart the server.

Each `--instance` adds an instance, with pages at `/<name>/runs` and `/<name>/graph`. Without a selection the studio serves all instances under the data root. `--repo` selects a checkout; `--dir <graph> --data <store>` opens a standalone graph and run store. Failed instances show their errors while others remain available.

`--plugins <dir>` adds [studio pages](plugins.md#studio-pages) across served instances, such as [Bench](bench.md#cost-against-quality) with `--plugins examples/plugins/bench`. Instance graph plugins read only that instance. The studio permits comments and run labels; other actions use the CLI.

Set `AGENTGRAPH_STUDIO_URL` in the shell or an instance env file to link tracker posts to their runs. The Runs page can filter to runs waiting for people and open their check results.

<!-- code: studio/vite.config.ts#server, src/services.ts#pickAuth, studio/watch.ts#restart --> <!-- code: studio/dev.ts studio/served.ts#readInstanceServed studio/src/state.ts#shown src/main.ts#removeShellSettings --> <!-- code: src/main.ts#readInstanceEnv --> <!-- code: studio/src/App.tsx#official studio/src/App.tsx#custom --> <!-- code: studio/src/runs/RunsPage.tsx#RunsPage src/status.ts#findRunsWaitingOnPeople studio/src/results/ResultTable.tsx#RunResultBadge -->

## Named instances and settings

An instance binds a checkout to a graph and tracker under one data root. `--instance <name>` selects `<root>/<name>/instance.yaml`; the default name is the checkout basename. To create an explicit name, add `--repo <dir>`. Names are single path components and cannot refer to another checkout. Ambiguous or unknown selections fail and list the available instances. <!-- code: src/instance.ts#ensureInstance src/instance.ts#findInstances src/instance.ts#readPickedInstance -->

The [record](runs.md#instanceyaml) stores paths and defaults. Relative paths resolve against the instance folder; flags apply to one command. `loop: true` includes the instance in a loop selected outside a repo. Unknown fields fail. <!-- code: src/settings.ts#InstanceFile src/instance.ts#readInstance src/instance.ts#ensureGraph src/instance.ts#ensureInstanceGraph -->

Settings use the first value from flags, the instance env file, `instance.yaml`, the shell, then provider defaults. <!-- code: src/main.ts#readEngineEnv src/main.ts#readInstanceEnv src/services.ts#readTrackerName -->

| Value              | Flag         | `instance.yaml` field | Env name              | When none sets it                                              |
| ------------------ | ------------ | --------------------- | --------------------- | -------------------------------------------------------------- |
| Tracker repository |              | `repo`                | `AGENTGRAPH_REPO`     | empty                                                          |
| Trust              |              | `trust`               | `AGENTGRAPH_TRUST`    | instance `owner`, tracker collaborators                        |
| Image              |              | `image`               | `AGENTGRAPH_IMAGE`    | graph `image`, stock sandbox image                             |
| Tracker            | `--tracker`  | `tracker`             | `AGENTGRAPH_TRACKER`  | `github` with App credentials, folder                          |
| Runner             | `--runner`   | `runner`              | `AGENTGRAPH_RUNNER`   | `local`                                                        |
| Provider           | `--provider` | `provider`            | `AGENTGRAPH_PROVIDER` | harness config                                                 |
| Graph path         | `--dir`      | `graph`               | `AGENTGRAPH_DIR`      | checkout `.agentgraph/`                                        |
| Harness config     |              |                       | `AGENTGRAPH_CONFIG`   | data root `config.ts`, engine config                           |
| Parallel drives    |              | `limits.parallel`     |                       | graph `limits.parallel`                                        |
| Base               | `--base`     | `base`                |                       | tracker default; a workflow `base` comes before the instance's |

An empty trust list trusts nobody. Graph settings reject `repo` and `trust`; image and parallel limits remain graph defaults. `AGENTGRAPH_APP_ENV` names an App credential file, `AGENTGRAPH_DATA` selects the root, and `--logs` overrides `AGENTGRAPH_CHECK_LOGS`. <!-- code: src/settings.ts#getSettings src/harnesses.ts#readConfiguredGraph src/main.ts#start -->

The studio rereads instance settings on reload; an explicit `--dir` stays in force. <!-- code: src/instance.ts#ensureInstanceGraph studio/served.ts#readInstanceServed studio/plugins.ts#makeStudioPagesPlugin bin/run.ts#serve -->

### One loop for several instances

`agi loop --instance a --instance b` drives both. Outside a repo without `--instance`, it selects records with `loop: true`. Each keeps its own graph, tracker, trust, env and session permits; `--parallel <n>` caps drives across them. Put per-instance flags in each record. A shared `--provider` applies to all. <!-- code: bin/run.ts#loop bin/run.ts#serve src/run/trigger.ts#startLoopDrives -->

Multi-instance loops and studios ignore shell settings for App credentials, tracker, repository, trust, graph and provider, and report which were ignored. Use each instance's record or env file. A failed instance prints its reason while others continue; the process exits 1. Ctrl-C stops all instances and releases locks. <!-- code: src/main.ts#start src/main.ts#removeShellSettings -->

### Starting and stopping a loop

```sh
agi loop --detach --instance a --instance b
agi stop --instance a --instance b
agi restart --instance a --instance b
```

`agi loop` runs in the foreground; `--detach` starts it in the background and prints its PID and log path. Logs append under `<data root>/logs/`.

`agi stop` sends SIGINT and waits for release; `--force` sends SIGTERM. A loop serving several instances must be stopped with all of their names. `agi restart` stops and starts it detached. Without names, selection uses the current repo, or all loops under the root for `stop` and `loop: true` records for `restart`.

Each checkout has one loop lock under `AGENTGRAPH_STATE`. Separate worktrees need separate instances. A second loop reports the commands to stop or restart its holder; dead holders are recovered automatically.

<!-- code: bin/run.ts#stopLoops, bin/run.ts#detach, src/owner.ts#createLoopLock, src/owner.ts#isOwnerRunning, src/owner.ts#readStateDir -->
