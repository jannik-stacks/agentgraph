# Install and first run

You need Node 24, Docker used as a member of the `docker` group (not root), and `git config user.name` set. The sandbox image takes about 2.4 GB.

```sh
npm install -g @jannik-stacks/agi
```

`npx @jannik-stacks/agi <verb>` runs it without installing. The unscoped `agentgraph` package on npm is unrelated.

Before it files anything, `agi` checks Docker, creates the networks `agentgraph-sandbox`, `agentgraph-models` and `agentgraph-egress`, builds missing or changed images and starts an egress proxy. It stops early when Docker is down, when it runs as root, or when the provider's gateway is a sandbox-network name no container answers to. The first build takes about 3 minutes. `AGENTGRAPH_SANDBOX_URL` skips this. <!-- code: src/docker.ts#ensureDocker -->

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

`start`, `say` and `review changes` post, then drive that issue in the foreground until it waits or ends. While an `agi loop` holds the instance's lock, they only post and the loop picks the issue up. Only one loop runs per instance. <!-- code: src/main.ts#createLoopLock src/main.ts#isLoopHeld -->

After a drive the CLI prints why the run waits or stopped and the next commands. A runner error, such as a harness that cannot reach its model, makes the run wait; the drive and `agi show <n>` print its cause and trace path. A login the provider rejects stops the run, and for `claude` the CLI says how to drop the saved token. <!-- code: src/status.ts#formatRunnerError -->

Ctrl-C stops a drive; the run goes on at the next drive, such as `agi say 1 "go on"`. A second Ctrl-C quits at once. <!-- code: src/main.ts#start -->

## Where the result lands

When a drive ends, the branch shows up in your repo as `agentgraph/<n>`, and the CLI prints the diff stat and next commands. Your checkout, index and HEAD never move, and no other branch does. A branch you moved or checked out stays yours, and one you deleted stays deleted until `agi export <n>`; the CLI says how to export under another name. <!-- code: src/instance.ts#writePullToRepo -->

Agentgraph only reads your repo, except for that branch: it adds the run's objects as one pack and moves `refs/heads/agentgraph/<n>` only from where it last wrote it. It never runs your hooks, signs, starts a gc or takes your index lock, and its checkouts live in the instance, not in your repo's worktrees. <!-- code: src/git.ts#hostGit src/docker.ts#dockerSandbox -->

For a repo agentgraph must not write to at all, pass `--read-only` on first use. Then nothing goes into the repo, and `agi export <n> --patch <file>` hands you the change. <!-- code: src/instance.ts#ensureInstance -->

## The base

The base is the branch checked out on first use, or `origin`'s default on a detached head, else `main`; `--base <branch>` overrides it for one command. Before each drive it fast-forwards to yours. If both moved, the drive stops: merge agentgraph's base into yours and retry. Workflows without a `base` start from it. <!-- code: src/instance.ts#ensureBase src/main.ts#start -->

## The studio

The studio shows the graph, every run and the Results tab. It only reads. Inside a repo, `agi studio` starts it for that repo; it needs a clone of agentgraph and installs the studio's dependencies on first use. By hand, from a clone:

```sh
cd studio && npm install
npm run dev -- --repo ~/code/left-pad
```

It serves on port 5182, or `AGI_PORT`, and restarts when engine code under `src` or `bin` changes. `--repo` reads that repo's instance; `--dir <dir> --data <dir>` pick the inputs instead, and `--tracker <dir>` makes the Inbox show local commands. `npm run dev -- --bench <dirs>` fills the [Bench](bench.md#cost-against-quality) tab, and `npm run dev -- --tune <dir>` the [Results](checks.md#the-results-tab) tab's tunes.

The Inbox lists runs that wait for a person, with the commands `agi show` prints. <!-- code: studio/src/runs/InboxPage.tsx#InboxPage src/status.ts#findRunsWaitingOnPeople -->

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
record it cannot read with a one-line warning. <!-- code: src/instance.ts#ensureInstance src/instance.ts#findInstances -->

The record holds `checkout` (local checkout path), `repo` (GitHub `owner/name`),
`base`, `owner`, `exported`, and `loop` (boolean, initially false). Optional fields are
`graph`, `tracker` (plugin name), `trust` (logins), `env` (secrets/env file), `provider`,
`readonly`, `image`, and `limits.parallel`. Relative `checkout`, `graph`, and `env` paths resolve
against the instance folder. Omitted `graph` means the checkout's `.agentgraph/`.
Edit the record to change saved defaults; flags apply to one command. `loop` records intent
for a later engine scheduler; F1 still starts loops explicitly. Unknown fields fail.
<!-- code: src/settings.ts#InstanceFile src/instance.ts#readInstance src/instance.ts#ensureGraph src/instance.ts#ensureInstanceGraph -->

Highest priority comes first in this single precedence table.
<!-- code: src/settings.ts#getSettings src/harnesses.ts#readConfiguredGraph src/main.ts#readInstanceEnv src/services.ts#readTrackerName -->

| Value              | Precedence                                                                               |
| ------------------ | ---------------------------------------------------------------------------------------- |
| Tracker repository | `AGENTGRAPH_REPO`, instance `repo`, empty                                                |
| Trust              | `AGENTGRAPH_TRUST`, instance `trust`, instance `owner`, tracker collaborators            |
| Image              | `AGENTGRAPH_IMAGE`, instance `image`, graph `image`, stock sandbox image                 |
| Parallel drives    | instance `limits.parallel`, graph `limits.parallel`                                      |
| Base               | `--base`, workflow `base`, instance `base`, tracker default                              |
| Tracker            | `--tracker`, `AGENTGRAPH_TRACKER`, App env inference, instance `tracker`, folder tracker |
| Provider           | `--provider`, `AGENTGRAPH_PROVIDER`, instance `provider`, harness config                 |
| Harness config     | `AGENTGRAPH_CONFIG`, data root `config.ts`, engine config                                |
| Graph path         | `--dir`, `AGENTGRAPH_DIR`, instance `graph`, checkout `.agentgraph/`                     |

An explicit empty trust list trusts nobody. The runtime graph carries these resolved values;
graph `settings.yaml` rejects `repo` and `trust`. Image and parallel remain graph defaults.
`AGENTGRAPH_PROVIDER`, `AGENTGRAPH_DIR`, and `AGENTGRAPH_TRACKER` remain command overrides
of their instance fields (an empty `AGENTGRAPH_PROVIDER` counts as unset), with their CLI flags taking priority. `AGENTGRAPH_APP_ENV` remains
the App env-file override. `AGENTGRAPH_DATA` still selects the root. There is no engine
`AGENTGRAPH_PARALLEL`; `AGENTGRAPH_BASE` remains a check-script input. Host resources and
secret variables keep their existing meanings.

The instance `env` file supplies scoped values before the process environment and App env
file; explicit command flags win. It never changes `process.env`. Explicit `--logs` overrides
both env files and the process environment.
<!-- code: src/main.ts#readEngineEnv src/main.ts#readInstanceEnv src/main.ts#start -->

### Migrating an existing instance

Stop its loop before moving its folder. Choose a plain name, then run:

```sh
mv "$root/$old_name" "$root/$name"
```

For a graph with `repo:` and `image:`, delete only `repo: owner/name` from `settings.yaml`
and add `repo: owner/name` to the renamed folder's `instance.yaml`. Rename its checkout
line from `repo: <checkout path>` to `checkout: <checkout path>` first. Keep graph `image:` and `limits.parallel:` unchanged; they remain defaults.
If graph `trust:` exists, delete it there and add the same list as `trust:` in the instance.
Keep `base`, `owner`, `provider`, and `exported`; add `loop: false`. For an external graph,
add `graph: <absolute graph path>` to the instance. Add `tracker: github` and
`env: <App env file>` for a GitHub instance; local instances may omit `tracker`.
Use `--instance <name>` on subsequent commands when the name differs from the checkout
basename. Folder migration is manual. Tracker flags and App variables select a backend for this same
instance; every command keeps its data directory and trust. GitHub instances use their
`env` file for App credentials. Local origin confinement and branch export apply to local
trackers. Provider callbacks, validation and studio reloads read the same scoped environment.
<!-- code: src/main.ts#readInstanceEnv src/services.ts#makeTrackerSetup src/status.ts#formatInstanceFlags studio/served.ts#readServedGraph -->

Studio reloads resolve the instance graph and env file again and refresh their watch roots.
An explicit `--dir` keeps selecting that graph until the studio exits. CLI tracker setup and execution
use the same selected graph snapshot; stored-data commands do not discover graph plugins.
CLI loop passes retain idle-run compression from `AGENTGRAPH_COMPRESS_DAYS`.
<!-- code: src/instance.ts#ensureInstanceGraph studio/served.ts#readServedGraph studio/plugins.ts#makeStudioPagesPlugin bin/run.ts#loop -->
