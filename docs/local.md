# Install and first run

Install Node 24 and set `git config user.name`. The local runner also needs rootless Docker.

```sh
npm install -g @jannik-stacks/agi
```

Or use `npx @jannik-stacks/agi <verb>`. From a clone: `npm ci && npm run build && npm link`; rebuild after pulls. See [runner preparation](sandbox.md#runners).

## Models

Choose a [provider](sandbox.md#providers):

- Claude subscription: the first command runs `claude setup-token` and saves the token.
- ChatGPT for `codex`, `opencode` or `pi`: `--provider chatgpt --save` runs `codex login` once. Read [credential exposure](sandbox.md#a-chatgpt-login-in-sessions).
- Anthropic: `export ANTHROPIC_API_KEY=...`, then `--provider anthropic --save`.
- ChatGPT, OpenRouter or local models through [infra/local](../infra/local/README.md): `set -a; . infra/local/.keys.env.local; set +a`, then `--provider litellm`. Only `litellm` needs this stack.

## First run

Inside your repo, copy the installed starter:

```sh
cp -R "$(npm root -g)/@jannik-stacks/agi/examples/starter" .agentgraph
```

For a clone or `npx`, use `cp -R examples/starter <repo>/.agentgraph`. Review and edit its agents, workflows and checks. It implements, tests and reviews, then awaits human merge. Tests use your repo's `test` script when present.

```sh
agi start "padStart drops the last char when len is 0"
```

This creates an instance under `~/.agentgraph`, files issue 1 in its folder tracker and drives it. <!-- code: src/main.ts#start -->

```sh
agi show
agi review 1 changes "also cover len 0"
agi merge 1
git merge agentgraph/1
```

See [graph selection](reference.md#which-graph-runs) and [CLI](cli.md). Keep durable data outside temporary folders. <!-- code: src/main.ts#temporary -->

## Who drives

`start`, `say` and `review changes` drive until the issue waits or ends. If a loop holds the checkout, they only post. See [several instances](#one-loop-for-several-instances). <!-- code: src/owner.ts#createLoopLock src/owner.ts#readLoopHolder -->

The CLI prints next commands. `show` includes errors and trace paths. Ctrl-C interrupts; the next drive resumes. <!-- code: src/status.ts#formatEngineError src/main.ts#start -->

## Where the result lands

Drives export `agentgraph/<n>` and print diff stats. Your checkout, index, HEAD and other branches stay unchanged. Branches you moved or checked out stay yours. Deleted branches require `export`; `--as` exports under another name. <!-- code: src/instance.ts#writePullToRepo -->

`merge` closes the open issue identified by the branch's run record, including retry branches. Without a matching record, it closes no issue. <!-- code: src/instance.ts#findPull src/instance.ts#mergePull -->

Host git imports objects and writes exported refs without hooks or signing; engine checkouts stay inside instances. <!-- code: src/git.ts#hostGit src/mirror.ts#makeSandbox -->

Pass `--read-only` on first use to prevent repo writes. Retrieve changes with `export <n> --patch <file>`. <!-- code: src/instance.ts#ensureInstance -->

## The base

The initial base is your checked-out branch. On detached HEAD, it uses `origin`'s default, else `main`. `--base` overrides one command. Each drive fast-forwards the instance base to yours. If both moved, merge the instance base into yours and retry. Workflows without `base` use this branch. <!-- code: src/instance.ts#ensureBase src/main.ts#start -->

## The studio

`agi studio` needs an engine clone and installs dependencies automatically. It serves at `127.0.0.1:5182`; `AGI_HOST` and `AGI_PORT` override this. [Auth](plugins.md#auth) covers login URLs. Changes in `src` or `bin` restart it. <!-- code: studio/vite.config.ts#server studio/watch.ts#restart -->

`/runs` lists runs across instances. `?instance=<name>` filters to one, preserves other filters and rejects unknown names. Rows identify instances. Run links use `/<name>/runs/<id>`; instance pages use `/<name>/runs` and `/<name>/graph`. The header names the selection; the logo returns to `/runs`. <!-- code: studio/src/state.ts#shown studio/src/state.ts#getRunsAtom studio/src/runs/RunsPage.tsx#RunListLive -->

Repeat `--instance` to select several instances; otherwise all instances under the data root appear. `--repo` selects a checkout; `--dir <graph> --data <store>` serves a standalone graph and run store. Failed instances show errors while others remain available. <!-- code: studio/dev.ts studio/served.ts#readInstanceServed -->

`--plugins` adds [pages](plugins.md#studio-pages), such as [Bench](bench.md#cost-against-quality) with `--plugins examples/plugins/bench`. Instance names `plugins` and `runs` are reserved. <!-- code: studio/src/App.tsx#official studio/src/App.tsx#custom -->

The Runs page filters runs waiting for people and opens their check results. See [Results](checks.md#the-results-tab) and [run links](runs.md#run-links). <!-- code: studio/src/runs/RunsPage.tsx#RunsPage src/status.ts#findRunsWaitingOnPeople studio/src/results/ResultTable.tsx#RunResultBadge -->

## Named instances and settings

An instance binds a checkout, graph and tracker. `--instance` selects `<root>/<name>/instance.yaml`; the name defaults to the checkout basename. Add `--repo` to create an explicit name. Names must be single path components bound to one checkout. Unknown or ambiguous selections list instances and fail. <!-- code: src/instance.ts#ensureInstance src/instance.ts#findInstances src/instance.ts#readPickedInstance src/settings.ts#InstanceFile src/instance.ts#readInstance -->

See [records](runs.md#instanceyaml), [flags](cli.md#flags) and [graphs](reference.md#which-graph-runs).

Settings use the first value from flags, the instance env file, `instance.yaml`, the shell, then provider defaults. <!-- code: src/main.ts#readEngineEnv src/main.ts#readInstanceEnv src/services.ts#readTrackerName src/harnesses.ts#readConfiguredGraph -->

An empty `trust` list trusts nobody; see [trust](workflows.md#trust-and-scope). <!-- code: src/settings.ts#getSettings -->

The studio rereads settings on reload; an explicit `--dir` stays in force. <!-- code: src/instance.ts#ensureGraph src/instance.ts#ensureInstanceGraph studio/served.ts#readInstanceServed studio/plugins.ts#makeStudioPagesPlugin bin/run.ts#serve -->

### One loop for several instances

`loop --instance a --instance b` drives both instances. Outside a repo without `--instance`, it selects records with `loop: true`. Each instance keeps its settings and session permits. `--parallel` caps drives across instances; `--provider` applies to all. Put other flags in each record. <!-- code: bin/run.ts#loop bin/run.ts#serve src/run/trigger.ts#startLoopDrives -->

Multi-instance loops and studios ignore shell settings for App credentials, tracker, repository, trust, graph and provider, and report this. Use instance records or env files. Failed instances leave others running; the process exits 1. Ctrl-C stops all instances and releases locks. <!-- code: src/main.ts#start src/main.ts#removeShellSettings -->

### Starting and stopping a loop

```sh
agi loop --detach --instance a --instance b
agi stop --instance a --instance b
agi restart --instance a --instance b
```

Loops run in the foreground. `--detach` starts them in the background and prints the PID and log path. Logs append under `<data root>/logs/`. <!-- code: bin/run.ts#detach -->

`stop` sends SIGINT and waits for lock release; `--force` sends SIGTERM. Name every instance the loop serves. `restart` stops and starts it detached. Without names, commands select the current repo. Outside a repo, `stop` selects all loops; `restart` selects `loop: true` records. <!-- code: bin/run.ts#stopLoops -->

Each checkout has one loop lock under `AGENTGRAPH_STATE`. Worktrees need separate instances. A second loop prints commands to stop or restart the holder. Locks from dead processes are recovered automatically. <!-- code: src/owner.ts#createLoopLock src/owner.ts#isOwnerRunning src/owner.ts#readStateDir -->
