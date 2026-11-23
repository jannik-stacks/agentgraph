# Install and first run

Install Node 24 or later. To run commands locally, install Docker and run agentgraph as a non-root user with access to Docker. When you create an [instance](index.md#terms), the engine uses the checkout's Git `user.name` as its owner, or your operating system login if the name is unset. The owner is the trusted login unless you configure trust. <!-- code: package.json src/docker.ts#whyRoot src/instance.ts#ensureInstance src/instance.ts#readOwner src/settings.ts#getSettings -->

```sh
npm install -g @jannik-stacks/agi
```

You can also invoke the CLI with `npx @jannik-stacks/agi <verb>`. To use a clone, run `npm ci && npm run build && npm link` there. Rebuild after pulling changes. See [Runners](sandbox.md#runners). <!-- code: package.json -->

## Models

Choose a [provider](sandbox.md#providers) for the model login or key your agent will use. For example, add `--provider chatgpt --save` to your first start command to log in and keep that choice for the instance. <!-- code: bin/run.ts#pickProvider harnesses/providers.ts#chatgpt -->

## First run

Inside your repository, copy the installed starter graph. A graph contains the workflows, agents and checks the engine will run. <!-- code: src/folder.ts#loadGraph examples/starter/settings.yaml -->

```sh
cp -R "$(npm root -g)/@jannik-stacks/agi/examples/starter" .agentgraph
```

From a clone, use `cp -R examples/starter <repo>/.agentgraph`. Review the copied graph before running it. The starter implements the request, tests it, reviews the changes and waits for you to merge. Its test check uses your repository's test script when present. <!-- code: examples/starter/workflows/issue.md examples/starter/checks/tests.md -->

```sh
agi start "padStart drops the last char when len is 0"
```

On first use, this creates the instance, files issue 1 in its [folder tracker](runs.md#the-tracker-folder) and drives the workflow until it waits or ends. Inspect the result, ask for a change and merge the finished branch into your checkout. <!-- code: bin/run.ts#runOnInstance bin/run.ts#drive src/instance.ts#ensureInstance -->

```sh
agi show
agi review 1 changes "also cover len 0"
agi merge 1
git merge --ff-only agentgraph/1
```

Keep the instance data outside temporary folders. See [graph selection](reference.md#which-graph-runs) and the [CLI](cli.md). <!-- code: src/main.ts#temporary -->

## Who drives

`start`, `say` and `review changes` normally drive the issue themselves. If [a loop](#the-loop) holds the checkout, they post to the tracker and leave the work for its next pass. <!-- code: bin/run.ts#drive bin/run.ts#runOnInstance -->

The CLI prints the next commands. `show` includes errors and trace paths. If you interrupt a drive with Ctrl-C, the next drive resumes it. <!-- code: src/status.ts#formatEngineError bin/run.ts#drive -->

## Where the result lands

After a drive the CLI exports the result to `agentgraph/<n>` and prints a diff summary. It leaves your working tree and index alone. If you checked out or moved the branch yourself, the engine leaves that branch alone too. To recover a deleted branch, use `export`. To export under a different name, add `--as`. <!-- code: bin/run.ts#report src/instance.ts#writePullToRepo -->

`merge` closes the open issue identified by the branch's run record, including branches created for retries. It leaves other issues open. Engine checkouts stay inside the instance. Git imports objects and writes exported refs without running hooks or signing commits. For a checkout that must stay read-only, see the [CLI flags](cli.md#flags). <!-- code: src/instance.ts#findPull src/instance.ts#mergePull src/git.ts#hostGit src/mirror.ts#makeSandbox -->

## The base

The base is the branch a run starts from. The instance initially takes your checked-out branch. If your checkout has a detached HEAD, the engine uses the default branch of `origin`, falling back to `main`. Each drive fast-forwards the instance base to yours. If both moved, merge the instance base into yours and retry. A workflow can specify its own base, and `--base` overrides it for one command. <!-- code: src/instance.ts#readBranch src/instance.ts#ensureBase src/settings.ts#getSettings -->

## The studio

From a clone, `agi studio` serves one instance for the selected checkout. It installs the studio dependencies on first use and prints a local URL. The default is `127.0.0.1:5182`. Set `AGI_HOST` or `AGI_PORT` to change it. Edits in `src/` or `bin/` restart the server. See [studio login](plugins.md#auth). <!-- code: bin/run.ts#openStudio studio/vite.config.ts#server studio/watch.ts#restart -->

To serve several instances, start the studio dev server directly from the clone. Repeat `--instance` to name them. Without a checkout, graph or instance selection, it discovers the instances under the data root. Use `--repo` for one checkout or `--dir <graph> --data <store>` for a standalone graph and run store. <!-- code: studio/package.json studio/dev.ts studio/served.ts#readInstanceServed -->

```sh
npm --prefix studio run dev -- --instance a --instance b
npm --prefix studio run dev -- --dir <graph> --data <store>
```

The Runs page at `/runs` lists runs from the served instances. Filter it with `?instance=<name>` or select the runs waiting for a person. Each row names the instance and links to the run and its [check results](checks.md#the-results-tab). Instance pages use `/<name>/runs` and `/<name>/graph`. The logo returns to the full list. <!-- code: studio/src/state.ts#shown studio/src/state.ts#getRunsAtom studio/src/runs/RunsPage.tsx#RunListLive studio/src/results/ResultTable.tsx#RunResultBadge -->

Add [plugin pages](plugins.md#studio-pages) with `--plugins`. For example, `--plugins examples/plugins/bench` adds [Bench](bench.md#cost-against-quality). The studio reserves the instance names `plugins` and `runs` for its own routes. It rereads settings on reload and keeps an explicit graph selection. <!-- code: studio/dev.ts studio/served.ts#readInstanceServed studio/plugins.ts#makeStudioPagesPlugin -->

## Named instances and settings

An instance connects a checkout to its graph, tracker and run data. Use `--instance` to select a saved name. To create a named instance, also pass `--repo` with its checkout. Each name must be a single path component and belongs to one checkout. See the [data folder](runs.md#the-data-folder) for the default name and location and [instance.yaml](runs.md#instanceyaml) for the record. <!-- code: src/instance.ts#ensureInstance src/instance.ts#readPickedInstance -->

For settings such as provider and tracker, flags take precedence, followed by the instance env file, the instance record, the shell and defaults. An explicit empty `trust` list trusts nobody. See [trust and scope](workflows.md#trust-and-scope). <!-- code: src/main.ts#readInstanceEnv src/services.ts#readTrackerName src/settings.ts#getSettings -->

## The loop

Run `agi loop` in your checkout to keep driving its issues. Each pass reads the graph and scans for work. The loop waits `AGENTGRAPH_EVERY` minutes between scans, five by default. A change in the folder tracker wakes it early. With a hosted tracker, a second poll checks for new events every `AGENTGRAPH_EVERY` minutes. Use `--once` for one foreground pass. <!-- code: bin/run.ts#serveLocked src/services.ts#hostSettings src/tracker.ts#waitForTrackerEdit src/main.ts#start -->

The loop runs in the foreground until you press Ctrl-C. To run it in the background, use `agi loop --detach`. Once it holds the checkout lock, it prints its process ID and the log path under `<data root>/logs/`. Only one loop can hold a checkout at a time. Worktrees use separate instances. A second loop reports how to stop or restart the holder. The engine recovers a dead process's lock. <!-- code: bin/run.ts#serve bin/run.ts#detach src/owner.ts#createLoopLock src/owner.ts#isOwnerRunning -->

`agi stop` sends SIGINT and waits for the loop to release its checkout. Add `--force` to send SIGTERM instead. `agi restart` stops the loop and starts it detached. <!-- code: bin/run.ts#stopLoops bin/run.ts#detach -->

### One loop for several instances

Name every instance when starting, stopping or restarting a shared loop. Each keeps its settings and queues. Use `--parallel` to cap sandbox commands across instances or `--provider` to choose the same provider for all of them. Set checkout-specific options in the instance records. <!-- code: bin/run.ts#loop bin/run.ts#serveLocked bin/run.ts#stopLoops -->

```sh
agi loop --detach --instance a --instance b
agi stop --instance a --instance b
agi restart --instance a --instance b
```

Outside a checkout, `loop` and `restart` without instance names select records with `loop: true`. An unnamed `stop` outside a checkout selects all loops. A multi-instance loop ignores shell settings for App credentials, tracker, repository, trust, graph and provider and reports which ones it ignored. One failed instance leaves the others running. When all finish, the process exits with code 1 if any failed. <!-- code: bin/run.ts bin/run.ts#loop src/main.ts#removeShellSettings -->
