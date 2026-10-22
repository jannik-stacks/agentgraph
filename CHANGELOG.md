# Changelog

## Unreleased

- A trusted comment speaks to the bot only when it says `/agent`, both to start a run and on the
  issue or pull request of a live run, review comments included. The `/bothub` command,
  `on.issue_comment.command` and plain replies are gone; write `issue_comment: {}`, and with several
  comment workflows name one as the first word after `/agent`.
- `@agent` calls the bot the same as `/agent`.
- An approval or merge that comes with `/agent` asks takes only itself; the asks go to the comment
  workflow.
- Only the comment workflow hears `/agent`; other runs hear what it tells them. A router agent
  decides with `comment`, `issue`, `run` (now with an optional `step`) and the new `tell`, which
  passes feedback, an answer, `stop` or `cancel` to the live run on an issue.

## 0.2.0

The baseline for tuning. From here on a repo gets better through its hub, and the engine changes
rarely. [The hub contract](docs/contract.md) lists the hub fields and commands that stay stable.

### Tuning

- `bin/tune.ts` climbs one hub per repo. Proposers write candidate hubs, each is scored on fit and
  validate cases against the current best, and a candidate is kept only when its gains hold on a
  rerun. Every candidate stays as a commit in the tune's hub repo.
- `tune init` records the engine as the release tag the checkout sits on, or as the commit, and
  every later run refuses an engine whose `src/` tree differs.
- The studio's Compound tab draws each tune's climb, its cost and the diff of each step.
- The `tune-graph` skill runs the same loop by hand, and `scripts/status.sh` sums a tune up on one
  screen.

### Toolchains

- When a checkout is made, a toolchain step installs what the repo names (the pinned Rust
  toolchain with clippy and rustfmt, then `cargo fetch`) into the `bothub-cache` volume, then runs
  the hub's new `toolchain` script. Later runs and checks reuse it and build offline.
- `BOTHUB_CACHE_VOLUME` names another volume, and an empty value turns the step off.
- A file lock in the cache volume stops two runners installing toolchains at once.

### Starting and sweeping

- A workflow with `issues: { label: agent:ready }` starts when a maintainer adds the label, once
  per issue. Adding it again after a done run starts nothing, and `/bothub restart` runs it again.
- `loop` first looks at every open issue once, so it catches up on what happened while it was
  down, then looks again every `BOTHUB_EVERY` minutes.
- GitHub calls that are safe to repeat are retried with backoff on network errors and 502 to 504.
- A warning at start when the data dir or its mirror is under a temp dir, which the OS may clear.

### Comments and pushes

- Once a question is answered, the status comment moves below the answer, so a finished run no
  longer reads as asking.
- A reply with no thread target is posted once, at the top level or under the newest thread, not
  into every open thread.
- Changes under `.github/` are left out of a push instead of refusing it, and the pull request
  names the files a maintainer must push.

### Check logs

- Every check's full output is kept gzipped by content hash, and a check row in the studio opens
  it on demand.
- `BOTHUB_CHECK_LOGS`, `--logs` or `logs` in `instance.yaml` keeps `all`, `failed` or `off`.
  `node bin/run.ts prune-logs --data <dir>` counts the logs no trace names, and `--apply` deletes
  them.

### Bench

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

## 0.1.0

The first versioned release.

### Engine

- Workflows start jobs from GitHub events or local issue files. A job casts a bot, hands it a
  skill and may stop on `until` or `requires`.
- Bots run on the opencode, pi or Claude Code harness. Each attempt ends in proposals that bothub
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

### Hubs and checks

- A hub is config: `hub.yaml`, bots, skills, checks, workflows and notes. `bothub check`
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
- Example hubs: `bothub`, `acme-app`, `clarinet`, `hub`. `bothub sim` replays scripted
  scenarios against a hub.

### Sandbox

- Every harness run, script job and script check runs in a throwaway container with a read-only
  root, dropped capabilities, resource limits and a private network.
- The container reaches the model proxy, an egress proxy that allows GitHub and the npm registry,
  and a relay to Ollama. No token goes in. Pushes happen on the host.
- When docker or the image is missing the run fails as `sandbox-failed`. Nothing runs on the host.
- Hubs set their own environment: dependencies, setup script and an open network when needed.
- A LiteLLM proxy with one virtual key per bot (`infra/local`), and `logs --spend` to compare
  recorded calls with the proxy's logs.

### Observability

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

### Data kept

- Runs, parked branches and mirrors are never deleted.
- Each attempt's commit is kept under `refs/bothub/attempts/<run id>/<n>` in the mirror.
- Every run's work is parked on `<branch>-parked-<run id>`. A worktree removed for any other
  reason first keeps unsaved work on `bothub/kept-<run id>`, locally only.
- A run's `home/` and its `tmp/` are kept after scrubbing secrets.
- The bench driver keeps each case's diff and data directory.

### Studio

- Studio draws each workflow as steps, bots and checks, shows what a job would see, and edits hub
  files with a save and commit action that commits as `update` and never pushes.
- Dashboard: runs, live events, diffs, pull requests, questions that need a human, and a stop
  button.
- Docs tab with the reference generated from the source.

### Bench

- `bench/mine.mjs` mines cases from merged pull requests, `bench/run.mjs` splits cases and runs
  hub settings over them, `bench/compare.mjs` compares diffs, and `bench/timeline.mjs` prints an
  issue's timeline.

### Known limits

- Each issue gets its own cargo build directory under the hub's cache, and nothing prunes old
  ones, so the cache grows with the number of issues.
- A hub change reaches only events after it. A run in flight keeps the old hub, and nothing warns
  about the runs it affects.
- Review questions that apply to every hub live in the bothub hub only.
- Run records are written to local disk. The `Files` interface for other backends is not wired
  in.
