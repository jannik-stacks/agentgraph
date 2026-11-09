# Install and first run

You need Node 24, Docker used as a member of the `docker` group (not root), and `git config user.name` set. The sandbox image takes about 2.4 GB.

```sh
npm install -g @jannik-stacks/agi
```

`npx @jannik-stacks/agi <verb>` runs it without installing. The unscoped `agentgraph` package on npm is unrelated.

Before it files anything, `agi` checks Docker, creates the networks `agentgraph-sandbox`, `agentgraph-models` and `agentgraph-egress`, builds missing or changed images and starts an egress proxy. It stops early when Docker is down, when it runs as root, or when the provider's gateway is a sandbox-network name no container answers to. The first build takes about 3 minutes. Another [runner](sandbox.md#runners) skips this. <!-- code: src/docker.ts#ensureDocker -->

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

The first command makes a local instance of the repo under `~/.agentgraph`, with a tracker folder that stands in for GitHub. It files the text as issue 1 and drives it: implement, test, review, then wait for you.

```sh
agi show                                   # what needs you
agi review 1 changes "also cover len 0"    # drives it again
agi merge 1                                # then: git merge agentgraph/1
```

Without a graph, commands that need one stop with a copy command. An `.agentgraph/` that git does not track, such as one in `.git/info/exclude`, is read from disk. With uncommitted changes in a committed `.agentgraph/` and no `--dir`, it says so and runs the committed version; the start banner names the graph, such as `.agentgraph/ at main 1a2b3c4`. <!-- code: src/instance.ts#ensureGraph src/instance.ts#whyGraphUncommitted src/instance.ts#formatGraphName --> Every verb is in the [CLI](cli.md). Keep the data root out of temporary folders, which macOS clears. <!-- code: src/main.ts#start src/main.ts#temporary -->

## Who drives

`start`, `say` and `review changes` post, then drive that issue in the foreground until it waits or ends. While an `agi loop` holds the checkout's lock, they only post and the loop picks the issue up. Only one loop runs per checkout; one loop can serve several, see [below](#one-loop-for-several-instances). <!-- code: src/owner.ts#createLoopLock src/owner.ts#readLoopHolder -->

After a drive the CLI prints why the run waits or stopped and the next commands. A runner error, such as a harness that cannot reach its model, makes the run wait; the drive and `agi show <n>` print its cause and trace path. A login the provider rejects stops the run, and for `claude` the CLI says how to drop the saved token. <!-- code: src/status.ts#formatRunnerError -->

Ctrl-C stops a drive; the run goes on at the next drive, such as `agi say 1 "go on"`. A second Ctrl-C quits at once. <!-- code: src/main.ts#start -->

## Where the result lands

When a drive ends, the branch shows up in your repo as `agentgraph/<n>`, and the CLI prints the diff stat and next commands. Your checkout, index and HEAD never move, and no other branch does. A branch you moved or checked out stays yours, and one you deleted stays deleted until `agi export <n>`; the CLI says how to export under another name. <!-- code: src/instance.ts#writePullToRepo -->

Agentgraph only reads your repo, except for that branch: it adds the run's objects as one pack and moves `refs/heads/agentgraph/<n>` only from where it last wrote it. It never runs your hooks, signs, starts a gc or takes your index lock, and its checkouts live in the instance, not in your repo's worktrees. <!-- code: src/git.ts#hostGit src/mirror.ts#makeSandbox -->

For a repo agentgraph must not write to at all, pass `--read-only` on first use. Then nothing goes into the repo, and `agi export <n> --patch <file>` hands you the change. <!-- code: src/instance.ts#ensureInstance -->

## The base

The base is the branch checked out on first use, or `origin`'s default on a detached head, else `main`; `--base <branch>` overrides it for one command. Before each drive it fast-forwards to yours. If both moved, the drive stops: merge agentgraph's base into yours and retry. Workflows without a `base` start from it. <!-- code: src/instance.ts#ensureBase src/main.ts#start -->

## The studio

The studio shows the graph, runs, results and Bench. Its [actions](plugins.md#studio-pages) post local comments and set run labels. A running loop picks up the comments. Inside a repo, `agi studio` starts it for that repo's instance; it needs a clone of agentgraph and installs the studio's dependencies on first use. By hand, from a clone:

```sh
cd studio && npm install
npm run dev -- --instance left-pad --instance right-pad
```

The studio listens on `127.0.0.1:5182`. Set `AGI_HOST` or `AGI_PORT` to change the address. Token auth is the default and prints a login URL; see [Auth](plugins.md#auth). Changes under `src` or `bin` restart the studio. <!-- code: studio/vite.config.ts#server, src/services.ts#pickAuth, studio/watch.ts#restart -->

One studio serves several instances of one data root: each `--instance <name>` adds one, and with none of `--instance`, `--repo` and `--dir` it serves every instance under the root. Each instance's pages live under its name, as `/<name>/runs` and `/<name>/graph`, and the header switches between instances. Graph, Runs and Results read only that instance. An address that names no served instance lists the ones served. An instance that fails to load shows why on its pages, and the others keep working. Each instance reads its settings as the loop does, so a studio of several ignores the per-instance settings in the shell, listed under [One loop for several instances](#one-loop-for-several-instances). <!-- code: studio/dev.ts studio/served.ts#readInstanceServed studio/src/state.ts#shown src/main.ts#removeShellSettings -->

`--repo <dir>` reads or makes that repo's instance. `--dir <graph>` picks the graph of a single instance; when serving several, set `graph` in each `instance.yaml`. `--dir <dir> --data <dir>` without an instance shows that graph and run store at `/runs`, and `--tracker <dir>` then makes the runs that need you show local commands. The [Bench](bench.md#cost-against-quality) tab shows the runs of every served instance, `npm run dev -- --bench <sets>` adds bench sets to it and a tune's runs show with `--dir <graph> --data <tune dir>/data`.

Set `AGENTGRAPH_STUDIO_URL` to the studio's address once, in the shell or an instance `env` file. An instance's posts link to `<address>/<name>/runs/<id>`, so a loop that drives several instances links each to its own runs. <!-- code: src/main.ts#readInstanceEnv -->

The header groups Graph, Runs, Results, Bench and Docs together. Pages from the graph's plugins appear in a separate group. [Studio pages](plugins.md#studio-pages) describes how the `builtin` flag selects the group. <!-- code: studio/src/App.tsx#official studio/src/App.tsx#custom -->

On the Runs page, the "need you" button narrows the list to runs that wait for a person, each with the commands `agi show` prints. Each run row carries a small badge for its gates that opens its results. <!-- code: studio/src/runs/RunsPage.tsx#RunsPage src/status.ts#findRunsWaitingOnPeople studio/src/results/ResultTable.tsx#RunResultBadge -->

## Named instances and settings

An instance binds one checkout to one graph in one data root. `--instance <name>` selects
`<root>/<name>/instance.yaml`; the default name is the checkout basename, with no hash.
An explicit name can select a saved checkout from outside its repo. Use two names for a
live instance and a bench instance of the same checkout. Every lookup uses the selected
`--data` root. Names are single path components; reusing one for another checkout fails.
An unknown `--instance <name>` stops and lists the instances in the root; add `--repo <dir>`
to make the new record. Without `--instance`, a missing record is made only when every other
folder in the root is an instance of another checkout. Otherwise the command stops and names
the folders: pass `--instance <name>` to use one. `agi show` outside a repo skips a
record it cannot read with a one-line warning. <!-- code: src/instance.ts#ensureInstance, src/instance.ts#findInstances, src/instance.ts#readPickedInstance -->

The record holds `checkout` (local checkout path), `repo` (GitHub `owner/name`),
`base`, `owner`, `exported`, and `loop` (boolean, initially false). Optional fields are
`graph`, `tracker` and `runner` (plugin names), `trust` (logins), `env` (secrets/env file), `provider`,
`readonly`, `image`, and `limits.parallel`. Relative `checkout`, `graph`, and `env` paths resolve
against the instance folder. Omitted `graph` means the checkout's `.agentgraph/`.
Edit the record to change saved defaults; flags apply to one command. `loop: true` puts the
instance in `agi loop` run outside a repo without `--instance`. Unknown fields fail.
<!-- code: src/settings.ts#InstanceFile src/instance.ts#readInstance src/instance.ts#ensureGraph src/instance.ts#ensureInstanceGraph -->

Each setting of an instance comes from the first of these that sets it: a command flag, the
instance's `env` file (and the App env file it names), `instance.yaml`, the shell environment
(and the App env file it names), the provider's defaults. The shell is a default for every instance.
<!-- code: src/main.ts#readEngineEnv src/main.ts#readInstanceEnv src/services.ts#readTrackerName -->

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

An explicit empty trust list trusts nobody. The runtime graph carries these resolved values;
graph `settings.yaml` rejects `repo` and `trust`. Image and parallel remain graph defaults.
`AGENTGRAPH_APP_ENV` names an env file with App credentials; an instance names its own in its `env`
file. `AGENTGRAPH_DATA` selects the root. There is no engine `AGENTGRAPH_PARALLEL`;
`AGENTGRAPH_BASE` remains a check-script input. `--logs` beats `AGENTGRAPH_CHECK_LOGS` everywhere.
<!-- code: src/settings.ts#getSettings src/harnesses.ts#readConfiguredGraph src/main.ts#start -->

Studio reloads resolve the instance graph and env file again and refresh their watch roots.
An explicit `--dir` keeps selecting that graph until the studio exits. CLI tracker setup and execution
use the same selected graph snapshot; stored-data commands do not discover graph plugins.
CLI loop passes retain idle-run compression from `AGENTGRAPH_COMPRESS_DAYS`.
<!-- code: src/instance.ts#ensureInstanceGraph studio/served.ts#readInstanceServed studio/plugins.ts#makeStudioPagesPlugin bin/run.ts#serve -->

### One loop for several instances

`agi loop --instance a --instance b` drives both in one process. Outside a repo and without
`--instance`, it drives every instance whose record says `loop: true`. Each instance keeps its own
graph, data, lock, tracker, trust, env file, provider and session permits, and its output lines start
with its name. `--repo`, `--dir`, `--base`, `--tracker` and `--read-only` select one instance, so
they fail here; put them in each `instance.yaml`. `--parallel <n>` caps drives across all of them.
The App settings (`AGENTGRAPH_APP_ENV`, `AGENTGRAPH_APP_ID`, `AGENTGRAPH_APP_KEY`, `AGENTGRAPH_APP_KEY_FILE`),
`AGENTGRAPH_TRACKER`, `AGENTGRAPH_REPO`, `AGENTGRAPH_TRUST`, `AGENTGRAPH_DIR` and `AGENTGRAPH_PROVIDER` belong to one
instance, so a loop or studio of several ignores them in the shell and says which it ignored; put them in each instance's `env`
file or `instance.yaml`, or pass `--provider` for all. Other settings, such as `AGENTGRAPH_STUDIO_URL`, stay shared.
An instance that fails to start, or stops on an error, prints `<name>: stopped: <why>` and the others go on;
the process then exits 1. Ctrl-C or SIGTERM stops every instance and releases each lock.
<!-- code: bin/run.ts#loop bin/run.ts#serve src/run/trigger.ts#startLoopDrives src/main.ts#start src/main.ts#removeShellSettings -->

### Starting and stopping a loop

```sh
agi loop --detach --instance a --instance b
agi stop --instance a --instance b
agi restart --instance a --instance b
```

`agi loop` runs in the foreground; Ctrl-C lets running drives wind down, and a second Ctrl-C quits.
With `--detach` it runs in the background and appends its output to
`<data root>/logs/loop-<names>-<date>.log`, named for its instances and the day it started. The
command returns once the loop holds every checkout and prints its pid and log, or prints the log and
fails if the loop exits first.

`agi stop` sends the loop SIGINT and returns once the loop has let go of the checkout; `--force`
sends SIGTERM, which ends it at once. Without `--instance` it stops the loop of the repo you are in,
or outside a repo every loop under the data root. When a loop also serves instances you did not
name, it refuses and prints the command that names them all. `agi restart` stops, then starts the
loop again with `--detach`; outside a repo without `--instance` it restarts the `loop: true`
instances.

A loop holds one lock per checkout, kept under `AGENTGRAPH_STATE`, so two instances or two data
roots never loop on one checkout. Two worktrees of a repo are two checkouts; give each its own
instance with `--instance <name> --repo <worktree>`. A second loop on a checkout fails with the
`stop` and `restart` commands to run, and waits instead while the holder is stopping. A lock whose
holder died is taken over at once on the same host, and after its two-minute heartbeat from another
host; runs go on where they were.
<!-- code: bin/run.ts#stopLoops, bin/run.ts#detach, src/owner.ts#createLoopLock, src/owner.ts#isOwnerRunning, src/owner.ts#readStateDir -->
