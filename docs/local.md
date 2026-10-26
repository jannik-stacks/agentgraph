# Install and first run

You need Node 24, Docker running as your user, and `git config user.name` set.

```sh
npm install -g @jannik-stacks/agi
```

Before it files or drives anything, `agi` checks that Docker runs. It creates the networks `agentgraph-sandbox`, `agentgraph-models` and `agentgraph-egress`, builds the sandbox and egress images when they are missing or changed, and starts an egress proxy. The first build takes a few minutes. `AGENTGRAPH_SANDBOX_URL` skips all of this. <!-- code: src/docker.ts#ensureDocker -->

## Models

Pick one of these; [Providers](sandbox.md#providers) has the details.

- A Claude subscription: the first `agi` command runs `claude setup-token` and keeps the token.
- An Anthropic key: `export ANTHROPIC_API_KEY=...`, then `--provider anthropic --save`.
- The local model stack, for ChatGPT, OpenRouter or local models: see [infra/local](../infra/local/README.md), then `--provider litellm`.

## First run

Inside any git repo:

```sh
agi start "padStart drops the last char when len is 0"
```

The first command makes a local instance for the repo under `~/.agentgraph`: a forge folder that stands in for GitHub, and the runs. It files the text as issue 1 and drives it: implement, run the repo's tests, review, then wait for you.

```sh
agi show                                   # what needs you
agi review 1 changes "also cover len 0"    # drives it again
agi merge 1                                # then: git merge agentgraph/1
```

Without `.agentgraph/` in the repo it uses the default graph; see [Which graph runs](reference.md#which-graph-runs). Every verb is in the [CLI](cli.md).

Keep the data root out of temporary folders: macOS deletes untouched files there after three days. Startup warns about it. <!-- code: src/main.ts#start src/main.ts#temporary -->

## Who drives

`start`, `say` and `review changes` post, then drive that issue in the foreground until it waits or ends. When an `agi loop` runs for the same repo, it holds the instance's loop lock, so these verbs only post and the loop picks the issue up. Only one loop runs per instance. <!-- code: src/main.ts#createLoopLock src/main.ts#isLoopHeld -->

Ctrl-C stops a drive. The run keeps its last saved state and goes on at the next drive of that issue, for example `agi say 1 "go on"`. A second Ctrl-C quits at once. <!-- code: src/main.ts#start -->

## Where the result lands

When a drive ends, the issue's branch is fetched into your repo as `agentgraph/<n>`. Your checkout never moves. The CLI prints the diff stat and the next commands.

A ref is written only when it is absent or still where agentgraph left it, so a branch you moved or checked out stays yours. The CLI then says how to export under another name. Git runs without your hooks, helpers or config. <!-- code: src/instance.ts#writePullToRepo src/git.ts#hostGit -->

## The base

The base is the branch checked out on first use, or `origin`'s default branch on a detached head, else `main`. `--base <branch>` changes it. Before each drive, agentgraph's base fast-forwards to yours. If both moved, the drive stops and prints both commits: merge agentgraph's base into yours and try again. Workflows that name no `base` start from this one. <!-- code: src/instance.ts#ensureBase src/main.ts#start -->

## The studio

The studio shows the graph, every run and the Results tab. It only reads. From a checkout of agentgraph:

```sh
cd studio && npm install
npm run dev -- --repo ~/code/left-pad
```

It serves on port 5182, or `AGI_PORT`; give each repo its own port. `--repo` reads that repo's instance. Instead, `--dir <dir> --data <dir>` pick the inputs, and `--forge <dir>` makes the Inbox show local commands. `npm run dev -- --bench <dirs>` fills the [Bench](bench.md#cost-against-quality) tab, and `npm run dev -- --tune <dir>` the Results tab at `/results`.

The Inbox lists runs that wait for a person, with the same commands `agi show` prints. A run that waits on a run it started is left out. <!-- code: studio/src/runs/InboxPage.tsx#InboxPage src/status.ts#findRunsWaitingOnPeople -->
