# Bench

The bench replays merged pull requests from their parent commit and issue. Hidden tests and blind judges score each arm against the merged change.

## Run a set

A bench dir holds `set.json` and `cases/`. `bench/drive.ts` runs every case at each point and repeat with the engine at `<dir>/<sha>/engine` (or `ENGINE`): validity, both arms, scoring and judging (`JUDGES`, default `opus:1,sonnet:2`; `none` skips).

```sh
git worktree add --detach <dir>/<sha>/engine <sha>
ln -s "$PWD/node_modules" <dir>/<sha>/engine/node_modules
SHA=<sha> POINTS=opencode:luna REPEATS=3 MAX_CODEX=45 KEYS=<keys file> node bench/drive.ts <dir>
node bench/drive.ts resume <dir>
```

Each run dir, `<dir>/<sha>/<harness>-<model>/r<k>`, gets `report.md` and `point.json`. Points take aliases such as `opencode:glm` ([OpenRouter](../infra/local/README.md#openrouter-models)). `BENCH_EXCLUDE=<repo>,<repo>` skips repos. Results are cached in `<dir>/.cache` (`BENCH_CACHE`) by case, arm, graph, engine `src` tree, point and repeat; `BENCH_FRESH=1` ignores it.

Before any job starts, the driver stops if the engine is not at `SHA` or has uncommitted changes, and names every queued point that has no list price or that the model proxy refuses a one-line request with the key its agents get. Logs go to `<dir>/logs/<harness>-<model>-r<k>-<case>.log` and `report-<harness>-<model>-r<k>.log`. `bench run` puts [run labels](runs.md#run-labels) on every run it starts: `case`, `arm`, `harness`, `model`, `repeat`, `engine` (its commit) and any `--label k=v`; the driver adds `set`, its `SHA` as `engine` and `LABELS`. Labels only describe runs: a job is done when its case is invalid, or when each arm has a scored diff and the judges wrote `judge/panel.json` unless `JUDGES=none`. When it finishes, the driver removes the score trees no process holds. <!-- code: bin/bench.ts#whyPointUnready bin/resume.ts#removeUnheldScoreTrees -->

`LABELS=experiment=skills,team=bench` adds free labels to `point.json`. Like the engine and model, `LABELS` is fixed on first start and restored on resume.

<!-- code: bench/drive.ts#parseBenchLabels bench/drive.ts#configure -->

## Cases

A case folder has `case.json`, `issue.md` and `merged.diff`. An optional `hidden.relaxed.diff` loosens merged tests that pin more than the issue says.

| Case field | Meaning |
| --- | --- |
| `repo`, `base`, `merged` | Repo and commits to replay |
| `test`, `suite`, `typecheck`, `setup`, `build` | Optional commands; `suite` defaults to `test` |
| `image` | Local image for scoring and both arms, such as `agentgraph-sandbox:node22` |
| `hasTests: false` | Metrics and judges only; hidden tests are recorded as skipped with a reason |
| `size`, `kind`, `area` | Case labels |
| `labels` | Extra case labels as a map of strings to strings |
| `control` | `bug` flips an added comparison; `padded` adds trivial tests |

Case commands override repo recipes. A case that touches test files without a test command is invalid, including repos without a recipe. Cases without test files record a hidden-test skip. The gate prints its verdict, reason and test counts; reports count skips and list their reasons.

A tested case is valid only if its hidden tests fail on base and pass on the human change, and the human change applies, sets up and passes the suite and typecheck. A coupling check rejects tests that import paths only the human added, use names the issue does not mention, or check snapshots. Invalid cases record why in `valid.json`. Repos whose tests start containers are left out.

Image selection uses case `image`, then the selected graph's `image`, then the operator fallback and stock sandbox. `BENCH_DIR` selects an external graph; floor replacement keeps that graph's resolved image. Each case saves its Docker ID in `image.json` before validity checks or arm reuse. Resume uses that ID even if the tag moves; restore a missing ID by rebuilding or pulling the original image. A Docker daemon that does not answer is reported as unreachable, not as a missing image, and the arm waits for it. A new output dir selects a new image. Validity, scores and arm caches include the ID, and arm `meta.json` and score records expose it. Old records without image identity are recomputed. <!-- code: bin/bench.ts#readCaseImage bin/bench.ts#armSlot src/docker.ts#readImage -->

Bench cleanup only considers labelled environment tags recorded in that case's `.envs/refs.jsonl`. It preserves live holds, pins and lower volumes still used by retained environments. Low disk blocks when scoped cleanup cannot free enough. <!-- code: src/disk.ts#collect src/disk.ts#ensureFreeDisk -->

## Arms

| Arm | What runs |
| --- | --- |
| `human` | The merged change |
| `v2` | The example graph named after the repo, else `examples/bench`: implement, check tests, review with one return, a human merge |
| `floor` | `bench/floor`: one session, same sandbox and budget, no checks or review |

Each arm starts from the base with the fix hidden. A scripted maintainer answers the first question with "No more information. Use your judgment."; a second ends the arm. An unfinished arm retries once, then counts as infra and stays out of the rates. An arm that changed nothing scores 0.

## Commands

```sh
node bin/bench.ts run v2 <case> <out> --repo <clone>
node bin/bench.ts score <case> <out> --repo <clone>
node bin/bench.ts judge <case> <out>
node bin/bench.ts report <out>
node bin/bench.ts status <out>
```

`run` writes `diff.patch`, `meta.json` and `usage.json`, and refuses a model without a list price. `score` runs the suite, typecheck and hidden tests, offline except setup, and counts lines, overlap, tests, sessions, cost and answers; `--drop-env` removes its environments. `judge` compares pairs blind through `claude -p` and the `smart` alias; `--judges opus:1,sonnet:2` sets the panel and diff orders, and a judge from the contestant's maker is swapped. `bench/judge.md` puts correctness first, then scope. `report` writes rates, win rates with bootstrap intervals, means, judge agreement and label sections, with cost at list price; an unpriced model is listed, never $0.

Keys come from `--keys` (`infra/local/.keys.env`). Paid steps stop past `--max-codex` weekly Codex points (30) or `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench <runs dir> <runs dir>
```

The Bench tab plots each point. Quality is 0 for nothing useful and 1 for matching the human: hidden tests, judge preference (doubled, capped at 1) and suite scores, weighted by sliders, minus penalties. Cases without hidden tests form a `judge-only` point. Checking cost stays out of an arm's cost. Crosses show 95% intervals; the staircase joins the points no cheaper point beats. Check fields are summed per point below; the [Results](checks.md#the-results-tab) tab has them all.

Each row has one `labels` map containing case attributes, explicit case labels, free run labels, and the harness, model, arm, engine, graph and set. Case attributes override free labels. Generated run attributes override both. Results makes every label available as an axis; its point axis is a display grouping when no explicit point label exists.

`agents-md`, `claude-md` and `skills` are `true` or `false` from read-only `git ls-tree` at the case base commit. Skills include `.claude/skills`, `.agents/skills`, `.cursor/rules` and `.github/skills`. New scores save them in the result's case record. Old runs derive them from their case tree clone or the standard repo clone when the base is available; otherwise those labels are absent. Old JSON needs no migration, including graph trees recorded as `"hubs"`.

<!-- code: bin/bench.ts#readBenchRows bin/bench.ts#readBenchSetupLabels studio/src/results/result.ts#readBenchRowResults -->

The Bench controls discover every label key. URL `where` is a JSON object of label keys to allowed value arrays, `by` is a comma-separated list of grouping keys, and `color` is a label key (empty means no colour). Values within a filter are alternatives; all filtered keys must match. Colour also splits points. For example, `/bench?where=%7B%22repo%22%3A%5B%22stx-labs%2Fexplorer%22%5D%7D&by=model,graph&color=skills` compares model and graph on explorer, coloured by skill presence. Judge-only cases always stay separate. Omitting `by` groups by harness, model, arm, engine, graph and set; an empty `by` combines them.

<!-- code: studio/src/bench/score.ts#summarise studio/src/bench/BenchPage.tsx#BenchPage -->

## Long runs

Rerun the same command after an interruption; `resume <dir>` rebuilds the queue from disk. `diff.patch` marks an arm done, live `<arm>.lock` holders are skipped, and abandoned work moves to `<case>/.attic/`. The first start pins its settings in `drive.json` and `env.json`; only budgets (`MAX_CODEX`, and `CAP` and `PER` for OpenRouter dollars) may change later. Low disk [holds work](sandbox.md#disk). `touch <dir>/PAUSE` takes no new job, the `parallel` file sets workers live, and Ctrl-C or `kill <pid in drive.lock>` stops. One driver runs per dir, and it exits 1 while jobs are left.

`sh bin/overnight.sh <queue>` runs a file of commands, each up to three times; `sh bin/overnight.sh status <queue>` shows progress. Keep queues out of `/tmp`. Tunes live under `AGENTGRAPH_TUNE` (`~/.agentgraph/tune`); `node bin/tune.ts status <tune dir>` shows one.
