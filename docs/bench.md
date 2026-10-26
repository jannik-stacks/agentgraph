# Bench

The bench replays merged pull requests from their parent commit and issue text. Hidden tests and blind judges score each arm against the merged change.

## Run a set

A bench dir holds `set.json` (the cases) and `cases/`. `bench/drive.ts` runs every case at each point and repeat, with the engine checked out at `<dir>/<sha>/engine` (or `ENGINE`): validity, the `v2` and `floor` arms, scoring and judging (`JUDGES`, default `opus:1,sonnet:2`; `none` skips).

```sh
git worktree add --detach <dir>/<sha>/engine <sha>
ln -s "$PWD/node_modules" <dir>/<sha>/engine/node_modules
SHA=<sha> POINTS=opencode:luna REPEATS=3 MAX_CODEX=45 KEYS=<keys file> node bench/drive.ts <dir>
node bench/drive.ts resume <dir>
```

Each run dir, `<dir>/<sha>/<harness>-<model>/r<k>`, gets a `report.md` and a `point.json` with harness, model, engine, graph, set and repeat. Points take aliases such as `opencode:glm` ([OpenRouter](../infra/local/README.md#openrouter-models)). `BENCH_EXCLUDE=<repo>,<repo>` names repos never run or reported. Results are cached in `<dir>/.cache` (`BENCH_CACHE`) by case, arm, graph, engine `src` tree, point and repeat; `BENCH_FRESH=1` ignores the cache.

## Cases

A case folder has `case.json`, `issue.md` and `merged.diff`. An optional `hidden.relaxed.diff` loosens merged tests that pin more than the issue says.

| Case field | Meaning |
| --- | --- |
| `repo`, `base`, `merged` | Repo and commits to replay |
| `test`, `suite`, `typecheck`, `setup`, `build` | Optional commands; `suite` defaults to `test` |
| `image` | Local scoring image, such as `agentgraph-sandbox:node20` |
| `hasTests: false` | Metrics and judges only |
| `size`, `kind`, `area` | Report strata |
| `control` | `bug` flips an added comparison; `padded` adds trivial tests |

A tested case is valid only if its hidden tests fail on base and pass on the human change, the human diff applies, setup works, and the human passes the suite and, where base does, the typecheck. Before any container runs, a coupling check rejects tests that import paths only the human added, use names the issue does not mention, or check snapshots. Invalid cases record why in `valid.json` and are skipped. Repos whose tests start their own containers are left out, since the sandbox has no Docker socket.

## Arms

| Arm | What runs |
| --- | --- |
| `human` | The merged change |
| `v2` | The example graph named after the repo, else `examples/bench`: implement, check tests, review with one return, a human merge |
| `floor` | `bench/floor`: one session, same sandbox and budget, no checks or review |

Each arm seeds its forge at the base, hiding the fix. A scripted maintainer answers the first question with "No more information. Use your judgment."; a second question ends the arm. An unfinished arm retries once, then counts as infra and stays out of win rates and means. An arm that changed nothing scores 0.

## Commands

```sh
node bin/bench.ts run v2 <case> <out> --repo <clone>
node bin/bench.ts score <case> <out> --repo <clone>
node bin/bench.ts judge <case> <out>
node bin/bench.ts report <out>
node bin/bench.ts status <out>
```

- `run` writes the forge, data, `diff.patch`, `meta.json` and `usage.json`. A model without a list price stops it before it spends.
- `score` runs the suite and typecheck on each diff, then the hidden tests, and counts lines, overlap with the human change, tests, sessions, cost and answers. `--drop-env` removes the scoring environments.
- `judge` compares pairs blind, with names masked, through `claude -p` on the host and the `smart` alias. `--judges opus:1,sonnet:2` sets the panel and how many diff orders each sees. A judge from the contestant's maker is swapped. `bench/judge.md` puts correctness first, then scope, and does not reward size.
- `report` writes counts, hidden-test rates, win rates with bootstrap intervals, means, judge agreement and strata.

Scoring runs offline, except setup. Keys come from `--keys` (`infra/local/.keys.env`). Paid steps stop past `--max-codex` weekly Codex points (30) or `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench <runs dir> <runs dir>
```

The Bench tab plots each point. Quality is 0 for nothing useful and 1 for matching the human: hidden tests passed, judge preference over the human (doubled, capped at 1) and suite scores, weighted by sliders, minus findings and question penalties. Cases without hidden tests form a `judge-only` point. Crosses show 95% intervals; the staircase joins the points no cheaper point beats.

## Long runs

Rerun the same command after an interruption. `diff.patch` marks an arm as done, live `<arm>.lock` holders are skipped, and abandoned work moves to `<case>/.attic/`. The first start pins its settings in `drive.json` and `env.json`, including the sandbox image, and later starts refuse changed values. Budgets (`MAX_CODEX`, `CAP` and `PER` for OpenRouter dollars) may change on any start. Low disk [holds work](sandbox.md#disk).

- Pause: `touch <dir>/PAUSE` takes no new job; `rm` it to go on. The `parallel` file sets the worker count live.
- Stop: Ctrl-C or `kill <pid in drive.lock>`. A budget stop takes no new job.
- Resume: `resume <dir>` rebuilds the queue from disk; finished jobs never rerun.
- One driver per dir. The driver exits 1 while jobs are left, so a queue retries it later.

`sh bin/overnight.sh <queue>` runs a file of shell commands, one per line, up to three times each, and `sh bin/overnight.sh status <queue>` shows progress. Keep queues and outputs out of `/tmp`. Tunes live under `AGENTGRAPH_TUNE` (`~/.agentgraph/tune`); `node bin/tune.ts status <tune dir>` shows one.
