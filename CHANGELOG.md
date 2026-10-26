# Changelog

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
