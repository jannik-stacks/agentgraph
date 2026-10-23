# Bench

The bench replays merged pull requests from their parent commit and issue text. Tests and blind judges score each arm against the merged change.

## Run it at a commit

```sh
BENCH_CASES=<miner cases> BENCH_REPOS=<clones> npm run bench -- --at <engine-commit> [--set smoke] [--fresh]
```

The command checks out `runs/<sha>/engine`, then runs validity, v2, floor, scoring and judging for `bench/sets/<set>.json`. It writes `report.md` and `compare.md` against the newest earlier report. Cases whose base differs from the set's pinned base are skipped.

| Option | Effect |
| --- | --- |
| `--cases-dir`, `--repos-dir` | Override `BENCH_CASES`, `BENCH_REPOS` |
| `--out` | Output root, default `runs` |
| `--parallel` | Concurrent cases, default 3 |
| `--point harness:model` | Repoint every hub agent; aliases include `opencode:glm` ([OpenRouter setup](../infra/local/README.md#openrouter-models)) |
| `--repeat k` | Separate repeat instead of reuse |
| `--pairs human` | Judge only pairs containing the human |
| `--judges` | Replace the [judge panel](#commands) |
| `--fresh` | Ignore shared caches |

Point or repeat options write under `runs/<sha>/<harness>-<model>/r<k>`. `point.json` records harness, model, engine, hub trees, set and repeat. `BENCH_POINT` also selects the model for arm commands; use explicit `--point` for matching commit-run metadata. `AGENTGRAPH_LLM_API_KEY_PT_<HARNESS>_<MODEL>` overrides every agent's key. `BENCH_HUB=<dir>` replaces the v2 hub and joins its cache key.

Shared results live in `runs/.cache`: validity keys include case, scoring code and sandbox image; arm keys include case, arm, hub, engine `src` tree (except floor), point and repeat; judge keys include judge and the ordered diff prompt. Existing outputs are skipped.

## Cases

Each case folder has `case.json`, `issue.md` and `merged.diff`. An optional `hidden.relaxed.diff` edits the merged test files after they reach the tree, for cases whose tests pin more than the issue states; such a case skips the coupling check.

| Case field | Meaning |
| --- | --- |
| `repo`, `base`, `merged` | Repo and commits to replay |
| `test`, `suite`, `typecheck`, `setup` | Optional commands; suite defaults to test |
| `image` | Local scoring base image, e.g. `agentgraph-sandbox:node20` from `infra/local/sandbox/node20`, or `agentgraph-sandbox:services` from `infra/local/sandbox/services` |
| `hasTests: false` | Metrics and judges only |
| `size`, `kind`, `area` | Report strata |
| `control` | `bug` flips an added comparison; `padded` adds trivial tests |

Mined cases list test files in `tests`; `plan` in `bin/bench.ts` derives repo commands, and a per-repo typecheck for explorer, stacks.js and clarinet that runs on every case. `bucket: no-tests` disables hidden tests, not the typecheck. It also plans stacks-blockchain-api, token-metadata-api, clarity-wasm, stacks-core, api-toolkit, connect, workers and stacks-mesh-api:

- Rust repos run one `cargo test` per hidden file: an integration target, a module of a target directory or a test module in src. Setup is the same for every case of a repo, so Envs are shared per lockfile: it fetches all crates, then builds the workspace tests where they compile; each case builds its own targets on top at score. clarity-wasm runs its clar2wasm tests once per `test-clarity-v*` feature, as its CI does.
- The API repos score in `agentgraph-sandbox:services`, whose `services` command starts PostgreSQL (on the `PG_PORT` from `.env`, else 5432, trust auth for `postgres`, sorting as en_US.UTF-8 like the postgres image CI uses) and Redis inside the container. stacks-blockchain-api runs each file through the package script whose jest config holds it, `test:<dir>` for `tests/<dir>/`.
- Repos whose tests start their own containers through the Docker API (signer-metrics-api, stacks-node-publisher, blockchain-api's `tests/2.5`) have no plan; the sandbox has no Docker socket.

Tested cases are valid only if hidden tests fail on base and pass on human, the human diff applies, setup works and the human passes the suite and the typecheck. A case without hidden tests is invalid only when the human fails the typecheck. A row counts the suite only where base passes it. Invalid cases record reasons in `valid.json` and skip arms and judges. Before containers run, a coupling check rejects tests importing human-only paths or names absent from the issue, or checking snapshots. Controls compare the human with its mutated copy; preferring the copy measures judge mistakes.

## Arms

| Arm | Behavior |
| --- | --- |
| `human` | Merged change |
| `v2` | Repo hub (`examples/clarinet`, `examples/sk`, `examples/sandbox`), otherwise `examples/bench`: implement, check tests, review with one return, then human merge. Small single-source edits skip review in the fallback hub. |
| `floor` | `bench/floor`: one session, same sandbox and budget, no checks or review |
| `v1` | Unavailable; needs a separate image, environment and leak-free seed |

Each arm seeds its forge with `init --at <base>`, hiding the fix. A scripted maintainer answers one question with "No more information. Use your judgment."; answers are counted.

Unfinished arms retry once, then become infra in `meta.json`, excluded from win rates and means. An arm that changed nothing is the agent's result: it is not rerun, its row says `outcome: no-change`, and it scores 0. Scoring setup failures also count as infra. Environment failures retry with backoff across restarts, logging `infra` in `log.jsonl`; after six failures they remain infra. Unreachable registries leave scores unwritten.

## Commands

```sh
node bin/bench.ts run v2 <case> <out> --repo <clone>
node bin/bench.ts run floor <case> <out> --repo <clone>
node bin/bench.ts score <case> <out> --repo <clone>
node bin/bench.ts judge <case> <out>
node bin/bench.ts report <out>
```

- `run` writes forge, data, hub copy, `diff.patch`, `meta.json` and `usage.json` under `<out>/<case>/<arm>`. Usage sums sessions, reported costs, tokens by model and class, and minutes over every attempt, set-aside ones included, and lists each attempt. `split` divides the time into session, tool, hub setup and check ms, plus the minutes of attempts lost to infra. A model without a list price stops `run` before it spends. Cached arms retain usage, not data; every arm, floor included, is keyed by the engine's `src` tree, and a reused arm's `meta.json` names its slot in `reusedFrom`. `--point` and `--repeat` also work here.
- `score` applies each diff to a shared base checkout, runs suite and typecheck, overlays human test files and runs hidden tests. A base row checks pre-change failure. Metrics count source/test lines, files, human-file overlap, added tests, branch-token changes, sessions, cost and answers. Usage comes from `usage.json`, otherwise traces. `--drop-env` removes scoring environments afterward; commit runs use it after the last arm, tunes retain environments for reuse.
- `judge` compares pairs with Opus and Sonnet via `claude -p`, and sol via proxy alias `smart`. Default `--judges opus:1,sonnet:2` sets one or both diff orders, the same panel for every row; a single order is chosen by case and pair. Add `sol:2` to widen it, or `--judges sol:1` to replace it. The studio unticks sol by default. Judges sharing the contestant's maker are replaced by another maker from sol, gemini, Opus, using upstream names in `infra/local/prices.json`. Prompts omit lockfiles, changelogs, `.tsbuildinfo` files, `.husky/` hooks, `.changeset/` notes and index lines, on both sides of a pair, and mask names and issue numbers. `bench/judge.md` prioritizes correctness, then scope, without rewarding size. JSON verdicts keep severity, category and preference beside raw replies. Each uncached call writes `<judge>.<n>.cost.json` with ms, tokens and usd (a list-price estimate for `claude -p` on a subscription); `report` sums them.
- `report` reprices from tokens at today's list price where a run recorded no cost, and rows say whether cost was recorded, list price or a subscription's list-price estimate. It writes valid/invalid/infra counts, hidden-test rates, win rates with bootstrap intervals, mean metrics, findings, judge agreement, strata and case tables.

Scoring commands run only in [Docker environments](sandbox.md#environments), offline except setup; missing Docker or images produces no score. Setup reruns for manifest changes or incomplete environments; otherwise case `build` runs on nonempty diffs. Progress appends to `<out>/log.jsonl`. Model keys use `--keys`, default `infra/local/.keys.env`. Paid steps stop above `--max-codex` weekly-use points since the first reading (30), or `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench <runs dir> <runs dir>
```

The Bench tab reads runs under these directories. Without `point.json`, it assumes opencode, `smart`, repeat 1 and directory name as set. Click a point for cases.

Quality combines hidden tests (the share of the tests base fails that the run passes, read from jest, vitest, cargo or node counts, else pass or fail), twice judge preference over human capped at one, and suite scores with slider weights, minus extra findings and question penalties. Zero means nothing useful; one matches human. The cap keeps every part on that scale, so a run judged better than the human cannot outscore one that passes the hidden tests. Cases whose human has no hidden tests form their own `judge-only` point per setup and never enter the tested mean; the report splits them as stratum `tests`. This is leaner than scoring each case on only the parts all its rows share: each row keeps one score, whatever it is compared with. Cost uses token list prices or elapsed minutes. Crosses show 95% bootstrap intervals over cases, then repeats. The staircase connects points no cheaper point beats; it stays dashed while any has fewer than ten valid cases.

## Long runs

Rerun the same command after interruption. Atomic renames protect results; `diff.patch` is written last to mark completion. Live `<arm>.lock` holders are skipped. Abandoned work moves to `<case>/.attic/` without checkouts; its containers are removed. Completed records remain, scoring trees are removed, and dependencies stay in Docker volumes. Low disk space [holds work](sandbox.md#environments).

Tunes live in `<root>/<repo>/<name>`, where the root is `AGENTGRAPH_TUNE`, by default `~/bothub-data/tune`. A tune's `run --until <iteration>` survives restarts. Unfinished phases wait and retry before giving up without a decision. First startup pins `BENCH_*`, `--keys`, `--point` and the sandbox image's id in `env.json`; every later arm and score runs that exact image, and a rebuilt tag stops the bench instead of mixing sandboxes. Restarts restore missing settings and reject changed values or missing paths. Edit that file for deliberate changes.

```sh
node bin/bench.ts status <out>
node bin/tune.ts status <tune dir>
sh bin/overnight.sh <queue>
sh bin/overnight.sh status <queue>
```

Status shows progress, infra, running work, retries, waits and estimates; tune status includes its phase. Queues contain shell commands, one per line, with `#` comments. Success appends to `<queue>.done` and is skipped thereafter. Failures retry three times with backoff, then wait for rerun. Output appends to `<queue>.log`; macOS uses `caffeinate`. Keep queues and outputs in a persistent directory, outside `/tmp`.

`bench/drive.ts` runs a whole set at one point with repeats, the way the luna and OpenRouter benches ran: `OUT` holds `set.json`, `cases/` and the engine checked out at `<OUT>/<SHA>/engine/agentgraph` (or `ENGINE`). It scores, runs v2 and floor, scores again and judges each job as it finishes (`JUDGES`, default `opus:1,sonnet:2` on human pairs; `none` skips). It spawns the node on `PATH` for every job, so a toolchain upgrade does not break later jobs, and a log write or spawn error fails that job, not the driver. `parallel` and `PAUSE` in `OUT` steer it live; `jobs.jsonl` records each job's start and end with the active count and host load.

```sh
OUT=<bench dir> SHA=<sha> POINT=opencode:luna REPEATS=3 MAX_CODEX=45 KEYS=<keys file> \
  node bench/drive.ts
```
