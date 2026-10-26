# Bench

The bench replays merged pull requests from their parent commit and issue text. Hidden tests and blind judges score each arm against the merged change.

## Run it at a commit

```sh
git worktree add --detach <dir>/<sha>/engine <sha>
ln -s "$PWD/node_modules" <dir>/<sha>/engine/node_modules
SHA=<sha> POINTS=opencode:luna REPEATS=3 KEYS=<keys file> node bench/drive.ts <dir>
```

A bench dir holds `set.json` (the list of cases) and the set's case dirs under `cases/`. The driver runs validity, v2, floor, scoring and judging for every case at each point and repeat with the engine checked out at `<dir>/<sha>/engine`, and writes `report.md` in each run dir `<dir>/<sha>/<harness>-<model>/r<k>`. Points take aliases such as `opencode:glm` ([OpenRouter setup](../infra/local/README.md#openrouter-models)). [Long runs](#long-runs) covers settings, budgets, pause and resume.

Each run dir's `point.json` records harness, model, engine, graph trees, set and repeat. For arm commands run by hand, `BENCH_POINT` selects the model and `BENCH_DIR=<dir>` replaces the v2 graph and joins its cache key. `BENCH_EXCLUDE=<repo>,<repo>` names repos a bench never runs or reports. `AGENTGRAPH_LLM_API_KEY_PT_<HARNESS>_<MODEL>` overrides every agent's key.

Shared results live in `<dir>/.cache` (`BENCH_CACHE`): validity keys include case, scoring code and sandbox image; arm keys include case, arm, graph, engine `src` tree (except floor), point and repeat; judge keys include judge and the ordered diff prompt. Existing outputs are skipped; `BENCH_FRESH=1` ignores the cache.

## Cases

A case folder has `case.json`, `issue.md` and `merged.diff`. An optional `hidden.relaxed.diff` loosens merged tests that pin more than the issue states; such a case skips the coupling check.

| Case field | Meaning |
| --- | --- |
| `repo`, `base`, `merged` | Repo and commits to replay |
| `test`, `suite`, `typecheck`, `setup`, `build` | Optional commands; `suite` defaults to `test` |
| `image` | Local scoring image, such as `agentgraph-sandbox:node20` or `agentgraph-sandbox:services` from `infra/local/sandbox/` |
| `hasTests: false` | Metrics and judges only |
| `size`, `kind`, `area` | Report strata |
| `control` | `bug` flips an added comparison; `padded` adds trivial tests |

Mined cases list their test files in `tests`, and `pickBenchTestCommands` in `bin/bench.ts` derives the commands per repo, with a typecheck for some repos on every case. `bucket: no-tests` turns off hidden tests but not the typecheck. Repos whose tests start their own containers have no plan, since the sandbox has no Docker socket.

A tested case is valid only if its hidden tests fail on base and pass on the human change, the human diff applies, setup works, and the human passes the suite and, where base does, the typecheck. A case without hidden tests needs only the diff to apply, setup to work and the human to pass the typecheck. Before any container runs, a coupling check rejects tests that import paths only the human added, use names the issue does not mention, or check snapshots. Invalid cases record why in `valid.json` and skip arms and judges.

## Arms

| Arm | What runs |
| --- | --- |
| `human` | The merged change |
| `v2` | The example graph named after the repo (`examples/<repo>`, `examples/sandbox` for `agentgraph-sandbox`), else `examples/bench`: implement, check tests, review with one return, then a human merge |
| `floor` | `bench/floor`: one session, same sandbox and budget, no checks or review |

Each arm seeds its forge with `init --at <base>`, hiding the fix. A scripted maintainer answers the first question with "No more information. Use your judgment."; a second question ends the arm where it waits. Answers are counted.

An unfinished arm retries once, then counts as infra in `meta.json` and stays out of win rates and means. An arm that changed nothing scores 0 with `outcome: no-change`. Scoring setup failures also count as infra.

## Commands

```sh
node bin/bench.ts run v2 <case> <out> --repo <clone>
node bin/bench.ts run floor <case> <out> --repo <clone>
node bin/bench.ts score <case> <out> --repo <clone>
node bin/bench.ts judge <case> <out>
node bin/bench.ts report <out>
```

- `run` writes the forge, data, graph copy, `diff.patch`, `meta.json` and `usage.json` under `<out>/<case>/<arm>`. Usage sums cost, tokens and time over every attempt. A model without a list price stops `run` before it spends.
- `score` applies each diff to a base checkout, runs the suite and typecheck, then adds the human test files and runs the hidden tests. It also counts lines, files, overlap with the human change, added tests, sessions, cost and answers. `--drop-env` removes the scoring environments afterward.
- `judge` compares pairs blind, with names and issue numbers masked, using Opus and Sonnet through `claude -p` on the host (so it needs a logged-in Claude CLI) and sol through the `smart` alias. The default `--judges opus:1,sonnet:2` gives each judge one or both diff orders; add `sol:2`, or replace the panel with `--judges sol:1`. A judge from the contestant's maker is swapped for another maker. `bench/judge.md` puts correctness first, then scope, and does not reward size.
- `report` writes valid, invalid and infra counts, hidden-test rates, win rates with bootstrap intervals, mean metrics, findings, judge agreement, strata and case tables. Cost is recorded, or estimated at list price, and each row says which.

Scoring runs only in [Docker environments](sandbox.md#environments), offline except setup. Progress goes to `<out>/log.jsonl`. Model keys come from `--keys`, default `infra/local/.keys.env`, and stay out of `process.env` except for an engine pinned by `BENCH_ENGINE`, which reads them there. Paid steps stop past `--max-codex` weekly Codex points since the first reading (30) or `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench <runs dir> <runs dir>
```

The Bench tab plots the runs under these directories. Without `point.json` it assumes opencode, `smart`, repeat 1 and the directory name as set. Click a point for its cases.

Quality is 0 for nothing useful and 1 for matching the human. It combines hidden tests (the share of the tests base fails that the run passes), judge preference over the human (doubled and capped at 1), and suite scores, weighted by sliders, minus extra findings and question penalties. The cap means a run judged better than the human cannot outscore one that passes the hidden tests. Cases without hidden tests form their own `judge-only` point. Cost is list-price tokens or elapsed minutes. Crosses show 95% bootstrap intervals over cases, then repeats. The staircase joins the points no cheaper point beats, dashed while any has fewer than ten valid cases.

## Long runs

Rerun the same command after an interruption. `diff.patch` is written last and marks an arm as done, live `<arm>.lock` holders are skipped, and abandoned work moves to `<case>/.attic/`. Low disk [holds work](sandbox.md#disk).

The first `run` or `score` into an output directory pins `BENCH_*`, `--keys`, `--point` and the sandbox image id in `env.json`. Later runs use that exact image and stop if the tag was rebuilt; restarts reject changed values. To change them, edit `env.json`. Tunes live in `<root>/<repo>/<name>`, the root being `AGENTGRAPH_TUNE` (default `~/.agentgraph/tune`).

```sh
node bin/bench.ts status <out>
node bin/tune.ts status <tune dir>
sh bin/overnight.sh <queue>
sh bin/overnight.sh status <queue>
```

`status` shows progress, infra, running work, retries, waits and estimates. A queue is a file of shell commands, one per line, with `#` comments. Each command runs up to three times with backoff; a success goes to `<queue>.done` and is not run again. Output goes to `<queue>.log`. Keep queues and outputs out of `/tmp`.

### Driving a whole set

`bench/drive.ts` runs a set at one or more points with repeats. A bench dir holds `set.json`, `cases/` and the engine at `<dir>/<SHA>/engine` (or `ENGINE`). For each job it checks validity, runs v2 and floor, scores and judges (`JUDGES`, default `opus:1,sonnet:2`; `none` skips).

```sh
SHA=<sha> POINTS=opencode:luna REPEATS=3 MAX_CODEX=45 KEYS=<keys file> node bench/drive.ts <dir>
node bench/drive.ts resume <dir>
MAX_CODEX=60 node bench/drive.ts resume <dir>
```

The first start records its settings in `drive.json`. Later starts need none and refuse a changed `SHA`, `POINTS`, `REPEATS`, `REPEAT`, `JUDGES`, `KEYS`, `SET`, `ENGINE` or `REPOS`. Budgets (`MAX_CODEX`, `CAP` and `PER` for OpenRouter dollars with `ORENV`) may change on any start.

- Pause: `touch <dir>/PAUSE` takes no new job and lets running ones finish; `rm <dir>/PAUSE` goes on. The `parallel` file sets the worker count live.
- Stop: Ctrl-C or `kill <pid in drive.lock>` stops running jobs. A budget stop takes no new job.
- Resume: `resume <dir>` rebuilds the queue from results on disk. Finished jobs are never rerun; partial jobs reuse their finished arms and judge calls.
- One driver per dir: a second exits 1. The driver also exits 1 while jobs are left, so a queue tries again later.
- Log: `events.jsonl` records starts, stops, pauses and each job, `budget-log.jsonl` the budget readings, and `logs/` each job's output. The studio's Bench tab lists every bench dir with its state and progress.
