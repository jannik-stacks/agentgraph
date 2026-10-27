# Changelog

## 0.0.3

### Patch Changes

- deb117a: A change asked of a run waiting at a human step goes back to work even when the reply could not be posted, and a reply under a review thread now goes to the pull request, not its issue.
- d74f0e2: A browser sandbox image, `infra/local/sandbox/browser`, adds Playwright's headless Chromium so graphs can run browser end-to-end tests with no network. A graph opts in with `image: agentgraph-sandbox:browser`.
- 2bdad12: The chatgpt provider now serves opencode and pi too. Agents run gpt-6.1-sol, and `fast` runs gpt-6-luna.
- 2781b8c: Read-only codex agents can read files again inside the docker sandbox. Codex no longer runs its own sandbox, which needs namespaces the container forbids; a session whose tools change nothing now gets its work tree, git dirs and dependency volumes mounted read-only instead, for every harness. A box server can't enforce that and refuses read-only sessions.
- f0bc68a: A trusted `/agent` on a closed issue, a merged or closed pull request, or an open pull request no run works on now starts the comment workflow, and a comment said just before a merge is no longer lost when the merge ends the run. A run on a pull request that is no longer open starts from its base branch.
- 4ffa29f: An `on: conflict` workflow resolves a waiting run's conflict with its moved base in a run of its own, with a budget of its own, while the first run keeps waiting. `examples/conflicts` shows one.
- 09bdec2: `agi dispatch` starts any workflow, the router included, and takes an optional text the run is asked first. `on: dispatch` now only decides what an agent's `run` proposal may start.
- 9a0913b: A forge loop now runs on the provider that AGENTGRAPH_PROVIDER names.
- 5140797: A long-running `agi loop` renews the provider login before each pass, so a ChatGPT login no longer expires mid-run. A failed renewal is logged and the pass keeps the last login.
- bae9827: The graph issue shape no longer asks an agent to prescribe the check that would catch a miss.
- b4514b4: A judge reads at most 200,000 characters of a change, its start and end.
- 6ea2bb2: A loop pass looks at issues with live runs first, so a runner-error retry or a reply no longer waits behind every open issue. Reading what happened asks GitHub once per person, not once per label event.
- d62543f: A local instance reads an `.agentgraph/` that git does not track straight from disk, so a private graph can live in `.git/info/exclude`. `AGENTGRAPH_DIR` now picks the graph inside a repo too.
- 8e53fe9: Workflows can start when an issue's card moves into a project board column: `on: { issues: { column: Agent Ready } }`. With a `label` too, a column start also adds the label.
- 2606d54: Harnesses read the prompt on stdin from a file in the session home, so a long prompt no longer overflows the argument limit with `spawn E2BIG`. A defect while a run works, such as a failed spawn, now parks that run with a runner error instead of stopping the loop.
- 0be5bf9: The default reviewer returns only `back`: its findings stay in the run instead of posting a pull request comment.
- 368caca: A retried session sees the proposal shapes again, and why its proposals failed to parse.
- 942481d: In a forge folder, a `pull_request` for a branch with an open pull request rewrites its title and body, as on GitHub, so a later step can keep the description current.
- d5d687b: A run a comment started now opens its prompt with that comment, its file and line, and the earlier comments of its review thread. A run with no branch reads the pull request it was asked on, and the timeline leaves out the runner's own labels and status comments.
- 13ba5ed: A run parked by a runner error now tries its step again on its own: after 10 minutes, doubling with each try, at most 5 times. A reply still tries it at once.
- c919798: A resumed session finds its home by name under the current data folder, so moving the data folder no longer stops runs with "is not a session home".
- 60a4f53: The shimmer on running graph nodes is half as strong.
- 400fd65: A GitHub read that a narrowed App token is refused with a 404 is tried once more with a new token, so pull requests and file contents in a private repo stay readable. A merged pull request that can't be read, or one issue GitHub refuses, no longer stops the whole pass.
- 7d08175: Each studio port keeps its own Vite cache, so two studios no longer wipe each other's dependencies.
- 66d3e9d: The sandbox image and the deploy engine image move to Debian trixie for git 2.47. The engine merges with `git merge-tree --merge-base`, which needs git 2.40 or later, so rebases failed in the deploy image and agentgraph's own tests failed in the sandbox. The sandbox image also gets jq. Rebuild `agentgraph-sandbox:local` to pick both up.
- 6ed0419: A step whose agent may push now fails a try that changes files but proposes no push, instead of passing with the change left unpushed.
- c91ab05: A local instance checks out from its forge directly, so the second copy of the repo in `mirror.git` is gone. Branches reach your repo as a pack and one `agentgraph/<n>` ref, without your hooks, gc or index lock; `--read-only` keeps a repo untouched. To migrate an instance, copy its kept files into the forge with `git --git-dir=<instance>/forge/origin.git fetch <instance>/data/mirror.git '+refs/agentgraph/runs/*:refs/agentgraph/runs/*'`, then move `mirror.git` aside.

## 0.0.2

### Patch Changes

- f5ad38e: Add a `chatgpt` provider: codex sessions run on a ChatGPT subscription through agentgraph's own `codex login`, with no gateway.

## 0.0.1

### Patch Changes

- 3bf9d78: First release on npm. Install it with `npm install -g @jannik-stacks/agi` and run `agi`. The package ships
  the CLI built to plain JavaScript, so it runs on Node 24 with no TypeScript loader. The studio still runs
  from a clone.

## Before npm

Work from before the first npm release. The 0.1.0 and 0.2.0 milestones never went to npm, so npm
versions start again at 0.0.1.

### After 0.2.0

- Check results move out of the trace into a per-run check record, `checks.jsonl`. Each entry has its
  time, the check's version and what judging it cost; a judge's transcript is its log, so judging no
  longer adds sessions to the run's trace. `run.json` has no `usd`; a run's cost is its sessions' sum.
  `check --runs` skips checks that already have a result under their current version, and trace-only
  checks run in an empty folder. A failed judge still records what it cost.
- Costs are the public list price from LiteLLM's pinned price table for every model, subscriptions
  included. A model without a price is listed as unpriced, never $0.
- The studio's Compound tab is now the Results tab at `/results`: what checks gave across runs, bench
  arms or tune candidates, as a table or a chart. A run's page shows its gates and results in two lines.
  `returns` fields take an optional `unit`. The example graph folds `tool-budget` into `run-stats`.

- The word hub is retired. `--hub` is `--dir`, `AGENTGRAPH_HUB` is `AGENTGRAPH_DIR`, `hub.yaml` is
  `settings.yaml`, `show hub` is `show graph`, the `hub` issue relation and label are `graph`, and the
  packaged default moved from `hub/` to `default/`. Sandboxes mount the folder at `/graph`. Tunes keep
  candidates under `cands/<id>/graph` and `graph.git`, and record `graph` instead of `hub`.
- `AGENTGRAPH_REPO`, when set, is the repo a graph works on instead of its `repo`, so a public graph can keep a
  placeholder.
- A committed `.agentgraph/` with symlinks or submodules is refused. The studio's Inbox commands carry
  the instance's `--repo` and `--data`.
- `start` and `say` take `--label`, repeatable; `show graph` prints the graph in use and its files.
- `npx agentgraph <verb>` inside any repo needs no setup: the first command makes a local instance
  under `--data`, `AGENTGRAPH_DATA` or `~/.agentgraph`. `start`, `say`, `review`, `merge`, `export`,
  `close`, `show`, `loop`, `check`, `dispatch` and `prune-logs` take the issue number as the handle.
  `bin/forge.ts`, `--instance`, `--issue <n>` as a run selector, `--all`, `status`, `tell` from the CLI
  and an instance's `keys.env` are gone. `--forge` or App credentials run the CLI as a runner, where
  `--data` stays the runs folder and `loop --once` replaces `--all`.
- Without `.agentgraph/` in the repo the CLI uses the packaged default graph; with it, the graph at the
  committed base.
- A finished drive writes `agentgraph/<n>` into your repo only when that ref is absent or still where
  agentgraph left it; `export --as` and `--patch` write elsewhere. The forge's base fast-forwards to
  your branch before each drive.
- `start`, `say` and `review changes` drive the issue in the foreground; while a `loop` holds the
  instance's lock they post and return with a `show` command. Ctrl-C stops a drive, and the run resumes on the next.
- `AGENTGRAPH_TRUST`, when set, is trusted instead of the graph's `trust`; the CLI sets it to the
  instance owner.
- instance.yaml has `repo`, `base`, `owner` and `exported`; `logs` is gone, use `--logs`.
- The studio takes `--repo` instead of `--instance`.
- Providers in `agentgraph.config.ts` (`claude`, `anthropic`, `litellm`) set the model
  settings for the harnesses they serve; `--provider`, `--harness` and `--model` pick, and an agent's
  harness the provider does not serve fails before filing. A subscription logs in on first use; the
  Claude token goes to the macOS Keychain.
- The `codex` harness always talks to the gateway as a custom Responses provider with the agent's key;
  a ChatGPT subscription comes from LiteLLM's `chatgpt/` models, which own the login and its refresh.
  The `chatgpt` provider and its `agentgraph-codex` volume are gone. The sandbox
  image installs Claude Code 2.1.296 and Codex 0.162.1, and the egress allowlist has their API hosts.
  It grants all of `edit`, `write` and `bash` or runs read-only; the graph check rejects tool limits it
  cannot keep.
- An agent's `harness` is optional: the first of `AGENTGRAPH_PROVIDER`'s, else the config's first.
  `AGENTGRAPH_HARNESS` runs every agent on one harness. `AGENTGRAPH_MODELS`
  maps model aliases, `*` for agents without a `model`.
- The CLI checks docker before it files or drives, and creates the sandbox networks, the egress proxy
  and the sandbox image when missing or out of date. The package is publishable: `bin/agentgraph.js` runs the
  TypeScript sources from `node_modules`, and `files` ships the engine, the default graph and the
  image sources.

- A check with `returns: number` traces a `value`: the share of items passed, or the number a script prints
  last. Without one it is `empty`, never 0.
- A workflow's `checks` run once when the run ends, as `warn`, and a killed runner runs the rest from the
  run's `owed`. `check <name>... --runs` runs checks on runs that already ended.
- A trusted comment speaks to the bot only when it says `/agent`, both to start a run and on the
  issue or pull request of a live run, review comments included. The `/agentgraph` command,
  `on.issue_comment.command` and plain replies are gone; write `issue_comment: {}`, and with several
  comment workflows name one as the first word after `/agent`.
- `@agent` calls the bot the same as `/agent`.
- An approval or merge that comes with `/agent` asks takes only itself; the asks go to the comment
  workflow.
- Only the comment workflow hears `/agent`; other runs hear what it tells them. A router agent
  decides with `comment`, `issue`, `run` (now with an optional `step`) and the new `tell`, which
  passes feedback, an answer, `stop` or `cancel` to the live run on an issue.
- An environment with dependency volumes counts as complete again when setup made nothing else, so a
  checkout with changed files no longer reinstalls its dependencies into its own volume. Existing
  environments are built once more.
- A bench run that drops a case's environment image also drops its dependency volume, and a bench
  command removes the dependency volumes of runners that are gone when it starts.
- `check` no longer names a replacement for a removed graph key, a retired proposal kind or a `bots/`
  folder; each fails like any unknown key or folder.
- The runner data dir defaults to `~/.agentgraph`, tunes to `~/.agentgraph/tune` and the bench
  driver's repos to `~/.agentgraph/tune/repos`. The cache collector no longer lists `bothub-*`
  docker objects.
- `node bench/drive.ts` is the one bench runner; `bin/bench-run.ts`, `npm run bench` and its
  `compare.md` are gone. The `v1` arm, which never ran, is gone too.

### Milestone 0.2.0

The baseline for tuning. From here on a repo gets better through its hub, and the engine changes
rarely. [The hub contract](docs/contract.md) lists the hub fields and commands that stay stable.

#### Tuning

- `bin/tune.ts` climbs one hub per repo. Proposers write candidate hubs, each is scored on fit and
  validate cases against the current best, and a candidate is kept only when its gains hold on a
  rerun. Every candidate stays as a commit in the tune's hub repo.
- `tune init` records the engine as the release tag the checkout sits on, or as the commit, and
  every later run refuses an engine whose `src/` tree differs.
- The studio's Compound tab draws each tune's climb, its cost and the diff of each step.
- The `tune-graph` skill runs the same loop by hand, and `scripts/status.sh` sums a tune up on one
  screen.

#### Toolchains

- When a checkout is made, a toolchain step installs what the repo names (the pinned Rust
  toolchain with clippy and rustfmt, then `cargo fetch`) into the `agentgraph-cache` volume, then runs
  the hub's new `toolchain` script. Later runs and checks reuse it and build offline.
- `AGENTGRAPH_CACHE_VOLUME` names another volume, and an empty value turns the step off.
- A file lock in the cache volume stops two runners installing toolchains at once.

#### Starting and sweeping

- A workflow with `issues: { label: agent:ready }` starts when a maintainer adds the label, once
  per issue. Adding it again after a done run starts nothing, and `/agentgraph restart` runs it again.
- `loop` first looks at every open issue once, so it catches up on what happened while it was
  down, then looks again every `AGENTGRAPH_EVERY` minutes.
- GitHub calls that are safe to repeat are retried with backoff on network errors and 502 to 504.
- A warning at start when the data dir or its mirror is under a temp dir, which the OS may clear.

#### Comments and pushes

- Once a question is answered, the status comment moves below the answer, so a finished run no
  longer reads as asking.
- A reply with no thread target is posted once, at the top level or under the newest thread, not
  into every open thread.
- Changes under `.github/` are left out of a push instead of refusing it, and the pull request
  names the files a maintainer must push.

#### Check logs

- Every check's full output is kept gzipped by content hash, and a check row in the studio opens
  it on demand.
- `AGENTGRAPH_CHECK_LOGS`, `--logs` or `logs` in `instance.yaml` keeps `all`, `failed` or `off`.
  `node bin/run.ts prune-logs --data <dir>` counts the logs no trace names, and `--apply` deletes
  them.

#### Bench

- `node bin/bench-run.ts --at <sha>` runs a case set on one engine commit. Arms are keyed by the
  engine's `src/` tree, so validity, arm and judge results are reused when only docs or hubs
  changed.
- `--point` (or `BENCH_POINT`) picks a harness and model, `--repeat` runs it several times,
  `usage.json` records what each run used, and the studio's Bench tab plots cost against quality.
- `BENCH_HUB` runs a case on a given hub, which is how a tune scores its candidates.
- Each repo's setup is built once per base commit into an image, and checkouts start from it.
  Scoring, validity and gating run every command in that container, and fail when docker or the
  image is missing instead of running on the host.
- Bench and tune runs survive a crash, a sleep or a dead proxy. Rerunning the same command resumes
  at the first unfinished run, partial work moves to `.attic/`, and a run that failed for
  infrastructure is retried, never scored as zero. `bench.ts status` and `tune.ts status` show
  progress, and `bin/overnight.sh` runs a queue of commands that resumes the same way.
- `tune/skill.ts` benchmarks the `tune-graph` skill as its own tune on the loop's cases, without
  the held-out ones.
- A finished run keeps only its records: dependencies live once per base in a docker volume that each
  checkout overlays with its own writes, never in a checkout,
  score trees go after scoring, Envs past `AGENTGRAPH_ENV_CAP` are evicted, and runs wait below
  `AGENTGRAPH_MIN_FREE_GB` free.

### Milestone 0.1.0

The first versioned release.

#### Engine

- Workflows start jobs from GitHub events or local issue files. A job casts a bot, hands it a
  skill and may stop on `until` or `requires`.
- Bots run on the opencode, pi or Claude Code harness. Each attempt ends in proposals that agentgraph
  validates before anything reaches the repository.
- Attempts repeat until the gating checks pass or the attempts run out. Failing findings go back
  to the bot. A human merges.
- Work that is parked or deferred resumes on the next run. Stalls, provider faults and crashed
  harnesses restart the session, at most twice per attempt, with a prompt that says why.
- Per-bot runs-per-day budgets, stop reasons recorded on each run, and a stop button.
- `serve` logs which model keys it loaded and why and how it exited, and refuses to start when a
  model endpoint rejects a bot's key.
- Context for each run: preloaded notes, surfaced notes and a decider model.
- A mirror per repository and one worktree per run.

#### Hubs and checks

- A hub is config: `hub.yaml`, bots, skills, checks, workflows and notes. `agentgraph check`
  validates it and fails closed.
- Checks are scripts or narrow bot judges, in modes `log`, `warn` and `block`. A script slices the
  change into hunks, items or files, and a bot answers one question per piece.
- A change with more items than a check takes is refused before any bot check runs, and the bot
  hears which check refused it and by how much.
- A check that already fails on the base commit in files the change did not touch is marked red on
  base. It does not hold the change, and the failure is filed once per base commit. The base
  result is kept per base commit and hub version.
- A human answer settles only what the bot asked. Review still fails a change that reaches past
  the issue, even when an answer asked for it.
- A docs paragraph that names code the change touched is read against the new code, even when the
  change edits no docs.
- Example hubs: `agentgraph`, `acme-app`, `clarinet`, `hub`. `agentgraph sim` replays scripted
  scenarios against a hub.

#### Sandbox

- Every harness run, script job and script check runs in a throwaway container with a read-only
  root, dropped capabilities, resource limits and a private network.
- The container reaches the model proxy, an egress proxy that allows GitHub and the npm registry,
  and a relay to Ollama. No token goes in. Pushes happen on the host.
- When docker or the image is missing the run fails as `sandbox-failed`. Nothing runs on the host.
- Hubs set their own environment: dependencies, setup script and an open network when needed.
- A LiteLLM proxy with one virtual key per bot (`infra/local`), and `logs --spend` to compare
  recorded calls with the proxy's logs.

#### Observability

- Each run leaves `run.json`, `prompt.md`, `events.jsonl`, `summaries.jsonl`, `outcome.json`,
  `stderr.log` and `spans.jsonl`. Secrets are masked.
- Traces: `spans.jsonl` holds the run as OpenTelemetry-shaped spans, metadata only, with a `run`
  span and `model_request`, `tool_use`, `check`, `ask`, `human_wait` and `stall` spans.
- Time buckets: every span carries a kind (model, edit, read, build, test, wait, stall, other).
  Hubs add shell patterns for build and test in `hub.yaml`.
- Timeline: `bench/timeline.mjs DATA ISSUE` prints one issue's runs, checks, human waits, cost and
  wall time per bucket, with wall time minus build and test.
- Every run records the engine commit and a hash of the hub's files; each hub version is kept
  under `hubs/`. Runs link to their parent and to the previous run on the issue.

#### Data kept

- Runs, parked branches and mirrors are never deleted.
- Each attempt's commit is kept under `refs/agentgraph/attempts/<run id>/<n>` in the mirror.
- Every run's work is parked on `<branch>-parked-<run id>`. A worktree removed for any other
  reason first keeps unsaved work on `agentgraph/kept-<run id>`, locally only.
- A run's `home/` and its `tmp/` are kept after scrubbing secrets.
- The bench driver keeps each case's diff and data directory.

#### Studio

- Studio draws each workflow as steps, bots and checks, shows what a job would see, and edits hub
  files with a save and commit action that commits as `update` and never pushes.
- Dashboard: runs, live events, diffs, pull requests, questions that need a human, and a stop
  button.
- Docs tab with the reference generated from the source.

#### Bench

- `bench/mine.mjs` mines cases from merged pull requests, `bench/run.mjs` splits cases and runs
  hub settings over them, `bench/compare.mjs` compares diffs, and `bench/timeline.mjs` prints an
  issue's timeline.

#### Known limits

- Each issue gets its own cargo build directory under the hub's cache, and nothing prunes old
  ones, so the cache grows with the number of issues.
- A hub change reaches only events after it. A run in flight keeps the old hub, and nothing warns
  about the runs it affects.
- Review questions that apply to every hub live in the agentgraph hub only.
- Run records are written to local disk. The `Files` interface for other backends is not wired
  in.
