# Without GitHub

Run `npx agentgraph` inside any git repo. The first command makes a local instance for that checkout: a forge folder that stands in for GitHub, and the runs. Your repo gets only `agentgraph/<n>` branches. No GitHub App is needed. Sessions need Docker and a model gateway, such as [the model stack](local.md#the-model-stack).

```sh
cd ~/code/left-pad
npx agentgraph start "padStart drops the last char when len is 0"
npx agentgraph show
npx agentgraph review 1 changes "also cover a negative len"
npx agentgraph merge 1
```

## Verbs

The issue number is the handle. Each issue has at most one open pull request, on `agentgraph/<n>`; every verb finds it by that branch, and a pull request's own number works too. <!-- code: src/instance.ts#findPull -->

| Verb | What it does |
| --- | --- |
| `start "<text>"` | Files the text as an issue with the label of `--workflow` (left out when one workflow has a label) and drives it. The first line is the title, the rest the body. `--label <label>`, repeatable, adds labels. <!-- code: src/main.ts#writeTriggeringIssue --> |
| `say <n> "<text>"` | An `/agent` comment on issue `n`, then drives it: an answer, feedback, `stop`, `cancel` or `restart`. `--line <path>:<line>` puts it on a line of the pull request; `--label <label>`, repeatable, labels the issue. |
| `review <n> approve` | Approves the pull request of issue `n`. |
| `review <n> changes "<why>"` | Requests changes, with the line comments made before it, then drives the issue. |
| `merge <n>` | Moves the forge's base to the pull request's head, retargets pull requests stacked on it, closes the issue and writes the branch into your repo. Fails if the base moved past it. <!-- code: src/instance.ts#mergePull --> |
| `export <n>` | Writes the branch into your repo again; `--as <branch>` under another name, `--patch <file>` as a patch file instead. |
| `close <n>` | Closes the issue and its pull request, whichever are open; a merged pull request stays merged. A live run stops on its next look. |
| `show [n]`, `show hub` | What needs you and every issue, or one issue's timeline and diff; `show hub` prints the hub in use, its path and files. Outside a repo it lists every instance and what needs you there. |
| `loop` | Drives every open issue, then again when the forge changes or after `AGENTGRAPH_EVERY` minutes. `--once` makes one pass. |

`check`, `dispatch` and `prune-logs` are in [the CLI](local.md#the-cli). Every verb takes `--data`, `--repo`, `--base`, `--hub` and `--logs`, and the commands it prints carry the `--repo` and `--data` it was given. `check --hub` inside a repo checks against the instance's saved provider. Comments, reviews and issues are by the instance owner, `git config user.name`, the only login the instance trusts. <!-- code: src/services.ts#settings -->

## The sandbox

Before it files or drives, the CLI checks that docker runs, creates the networks `agentgraph-sandbox`, `agentgraph-models` and `agentgraph-egress` when missing, builds the sandbox and egress images from the package when they are missing or their files changed, and starts an egress proxy when none is on the sandbox network. Without docker it stops before filing and says how to start it. `AGENTGRAPH_SANDBOX_URL` skips all of this. <!-- code: src/docker.ts#ensureDocker -->

## Models

A provider is where model calls go and how they authenticate. `agentgraph.config.ts` lists them; each names the harnesses it serves and sets the [model settings](hosting.md#models) for them. <!-- code: harnesses/providers.ts#makeProviders -->

| Provider | Harness | Ready when |
| --- | --- | --- |
| `claude` | `claude` | its token is in the macOS Keychain or `~/.config/agentgraph/claude-token`, or `CLAUDE_CODE_OAUTH_TOKEN` is set |
| `chatgpt` | `codex` | the device login in the docker volume `agentgraph-codex` was made |
| `anthropic` | `claude` | `ANTHROPIC_API_KEY` is set |
| `litellm` | any | `AGENTGRAPH_PROXY_KEYS` is set, for `AGENTGRAPH_PROXY_URL`; agents without a model get `smart` unless `AGENTGRAPH_MODELS` says otherwise |

`--provider` picks one for that command, and with `--save` for later ones too; else `provider` in instance.yaml, else `AGENTGRAPH_PROVIDER`, else the only ready one, which is saved. A subscription counts as ready when the host is logged in to it (`claude auth status`, `codex login status`); only the status is read, and the sandbox gets its own login. The CLI sets up docker before it looks. `chatgpt` keeps its login in a local docker volume, so it is never ready with `AGENTGRAPH_SANDBOX_URL`. When several are ready the CLI asks in a terminal and saves the answer, and fails without one. When none is ready it lists how to get one, and files nothing. Agents that name no harness get the provider's first. `--harness` runs every agent on one of the provider's harnesses, and `--model` replaces every agent's model, for that command only. An agent whose harness the provider does not serve fails before anything is filed. <!-- code: bin/run.ts#pickProvider -->

A subscription logs in once per machine, the first time it is picked. `claude` runs `claude setup-token` on the host and asks for the token it prints, then keeps it in the macOS Keychain, or elsewhere in a file only you can read; each Claude Code session gets it as `CLAUDE_CODE_OAUTH_TOKEN`. `chatgpt` runs `codex login --device-auth` in a sandbox container, so the login lives in the docker volume and never in your `~/.codex`. Codex sessions take turns on that volume, and their output masks its tokens. Either credential is inside the session's container while it runs.

## Who drives

`start`, `say` and `review changes` post, then drive that issue in the foreground until it waits or ends, printing each step. `merge`, `review approve`, `close` and `export` never drive.

When a `loop` runs for the same repo, it holds the instance's loop lock and the verbs only post; the loop takes the issue on its next pass, and `show <n>` shows where it stands. Only one loop runs per instance. <!-- code: src/main.ts#createLoopLock src/main.ts#isLoopHeld -->

Ctrl-C stops a drive. The run keeps its last saved state and goes on from there on the next drive of that issue, for example `say <n> "go on"`. A second Ctrl-C quits at once. <!-- code: src/main.ts#start -->

## Where the result lands

When a drive ends, the issue's branch is fetched into your repo as `agentgraph/<n>`. Your checkout never moves. The CLI prints the diff stat, a `git diff` line, a `git worktree add` line and the next commands.

A ref is written only when it is absent or still where agentgraph last left it, so a branch you moved or check out stays yours; the CLI then says why and how to export under another name. Git runs without your hooks, helpers or config. <!-- code: src/instance.ts#writePullToRepo src/git.ts#hostGit -->

## The base

The base is the branch checked out on first use, or `origin`'s default branch on a detached head, else `main`. `--base <branch>` changes it. Before each drive the forge's base fast-forwards to yours. When both moved, after a `merge` you did not take into your branch, the drive stops and prints both commits; merge agentgraph's base into yours and try again. <!-- code: src/instance.ts#ensureBase -->

Workflows that name no `base` start from the instance's base. <!-- code: src/main.ts#start -->

## The hub

1. `--hub <dir>`. `--hub .agentgraph` uses your working tree, uncommitted edits included.
2. Else `.agentgraph/` in your repo at the committed base, as the GitHub runner reads it. Each version is checked out once under the instance.
3. Else the default hub in the package: implement, review, then a human merge, with a check that runs the repo's `test` script when there is one.

<!-- code: src/instance.ts#ensureHub src/instance.ts#defaultHub -->

A committed hub with symlinks or submodules is refused. To change the default hub, copy the folder `show hub` prints to `.agentgraph/` in your repo, edit it and commit it.

## The data dir

```
~/.agentgraph/                      --data, else AGENTGRAPH_DATA, else ~/.agentgraph
  left-pad-7c1e2a-local/            <repo folder>-<hash of its real path>-local
    instance.yaml                   repo, base, owner, the refs written into the repo
    forge/                          issues, timelines, origin.git
    data/                           runs, traces, mirror
    hubs/                           committed hub versions
```

A data dir inside the repo is refused. A moved repo is a new instance; `show` outside a repo marks instances whose repo is gone. See [instance.yaml](reference.md#instanceyaml). <!-- code: src/instance.ts#ensureInstance -->

## The forge folder

A forge folder holds `<n>.md` issues, `<n>.jsonl` timelines, `<n>/pull.json` and `diff.patch` for pull requests, and a bare `origin.git`. Unlike GitHub, a forge folder refuses a whole push that touches `.github/`, and a second `pull_request` for a branch leaves the open one as it is. <!-- code: src/forge.ts#fileForge -->

`--forge <dir>` runs the CLI [on a forge folder](local.md#on-a-forge) instead of an instance, for tests and the bench.

## Dropped issue files

Any `<n>.md` you write into the forge folder, under an unused number, is an issue. The first line is the title and the rest is the body. To start a workflow, add frontmatter (YAML between `---` lines) with an `author` and the workflow's label. The next look starts the run when the author is trusted:

```md
---
title: Reject a negative count
author: morgan
labels: [agent:ready]
---

count(-1) should throw.
```

The first time the forge reads the issue, it records those labels as the author's, at the file's modification time. A run started from them takes its id from that time, so a runner that stops before saving the run starts the same run again, not a second one. Later label edits in the file record nothing. An author ending in `[bot]` or outside the trusted logins starts nothing. `start` writes such a file. <!-- code: src/forge.ts#fileForge src/forge.ts#writeIssueFile -->
