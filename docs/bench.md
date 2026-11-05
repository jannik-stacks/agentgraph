# Bench

The bench replays merged pull requests from their parent commit and issue. Hidden tests and blind judges score each arm against the merged change.

## Run a set

A set dir holds `set.json` and `cases/`. Every bench result is a run: an arm's session is an engine run, and the `human` and `base` references are [imported runs](runs.md) of the merged change and of no change. Scorers and judges add `bench/*` results to a run's `checks.jsonl` as later entries whose version is the scorer's hash, and never touch a forge. `bench/start-runs.ts` starts the runs its flags name and skips the ones already on disk:

```sh
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --arms v2,floor --keys <keys file>
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --dry
```

It wants every case of `set.json` times each arm, point and repeat, narrowed by `--cases`, with `--graph <dir>` and any `--label k=v`. Each run gates its case on the references, then runs, scores and judges its slot through `bin/bench.ts` (`--judges`, default `opus:1,sonnet:2`; `none` skips). Points take aliases such as `opencode:glm` ([OpenRouter](../infra/local/README.md#openrouter-models)). Before any run starts it names every queued point that has no list price or that the model proxy refuses a one-line request with the key its agents get. Logs go to `<set>/logs/<case>-<arm>-<point>-r<k>.log`. <!-- code: bin/bench.ts#whyPointUnready bench/runs.ts#isBenchRunDone -->

A run's identity is its origin input: case, arm, repeat, point, the git tree id of the graph source it runs from (the whole `examples` dir unless `--graph` names one, and `bench/floor` for floor), computed as the engine computes a run's `graphTree` and as the earlier drive recorded it, and any `--label k=v`, so changing the graph or a label starts new runs. The engine is not part of it: to rerun an older engine, run from its worktree into another set, or pass a label. Runs with the same identity share a slot. Every try is a new attempt: a set-wide number `n` and a private dir `<set>/attempts/<n>/` with `input.json`, the graph copy and its own tracker, which files the issue as number `n`. The run itself lands in the set's one store, `<set>/data/`, with its origin input carrying `attempt`. Started and imported runs both go through the bench plugin's [engine host](plugins.md#engine-access), which checks the labels and origin before the engine writes anything. A session mounts only its own attempt's tracker, so it never sees another contestant's change, a reference or a verdict. References are one slot per case at repeat 1, each in its own attempt. A run is done when its case is invalid, its arm failed for infra, or its slot has `bench/hidden` and, when judged, `bench/judge`. Scores land in one append, and a run that changed nothing gets a `bench/judge` marked n/a. [Run labels](runs.md#run-labels) record the same and more: `bench run` adds `set`, `case`, `arm`, `harness`, `model`, `repeat`, `attempt`, `engine` (its commit) and the `--label` pairs. Each call passes its tracker and graph as settings, so parallel arms never share process state. <!-- code: bench/runs.ts#getBenchSlot bench/runs.ts#makeBenchAttempt bench/runs.ts#readBenchSlots bin/bench.ts#runArm bin/bench.ts#writeAttemptImport src/engine.ts#makeEngineHost -->

## Cases

A case folder has `case.json`, `issue.md` and `merged.diff`. An optional `hidden.relaxed.diff` loosens merged tests that pin more than the issue says.

| Case field                                     | Meaning                                                                     |
| ---------------------------------------------- | --------------------------------------------------------------------------- |
| `repo`, `base`, `merged`                       | Repo and commits to replay                                                  |
| `test`, `suite`, `typecheck`, `setup`, `build` | Optional commands; `suite` defaults to `test`                               |
| `image`                                        | Local image for scoring and both arms, such as `agentgraph-sandbox:node22`  |
| `hasTests: false`                              | Metrics and judges only; hidden tests are recorded as skipped with a reason |
| `size`, `kind`, `area`                         | Case labels                                                                 |
| `labels`                                       | Extra case labels as a map of strings to strings                            |
| `control`                                      | `bug` flips an added comparison; `padded` adds trivial tests                |

Case commands override repo recipes. A case that touches test files without a test command is invalid, including repos without a recipe. Cases without test files record a hidden-test skip. The gate prints its verdict, reason and test counts; reports count skips and list their reasons.

A tested case is valid only if its hidden tests fail on base and pass on the human change, and the human change applies, sets up and passes the suite and typecheck. A coupling check rejects tests that import paths only the human added, use names the issue does not mention, or check snapshots. Invalid cases record why as a failed `bench/valid` result on the human run. Repos whose tests start containers are left out.

Image selection uses case `image`, then the selected graph's `image`, then the operator fallback and stock sandbox. `--graph` selects an external graph; floor replacement keeps that graph's resolved image. Each case saves its Docker ID in `<set>/work/<case>/image.json` before validity checks. Resume uses that ID even if the tag moves; restore a missing ID by rebuilding or pulling the original image. A Docker daemon that does not answer is reported as unreachable, not as a missing image, and the arm waits for it. A new set dir selects a new image. Scorer versions include the ID, and the `bench/setup` result records it. <!-- code: bin/bench.ts#readCaseImage src/docker.ts#readImage -->

Bench cleanup only considers labelled environment tags recorded in that case's `.envs/refs.jsonl`. It preserves live holds, pins and lower volumes still used by retained environments. Low disk blocks when scoped cleanup cannot free enough. <!-- code: src/disk.ts#collect src/disk.ts#ensureFreeDisk -->

## Arms

| Arm     | What runs                                                                                                                    |
| ------- | ---------------------------------------------------------------------------------------------------------------------------- |
| `human` | The merged change                                                                                                            |
| `v2`    | The example graph named after the repo, else `examples/bench`: implement, check tests, review with one return, a human merge |
| `floor` | `bench/floor`: one session, same sandbox and budget, no checks or review                                                     |

Each arm starts from the base with the fix hidden. A scripted maintainer answers the first question with "No more information. Use your judgment."; a second ends the arm. An unfinished arm retries once, then counts as infra and stays out of the rates. An arm that changed nothing scores 0.

## Commands

```sh
node bin/bench.ts import human <case> <set> --repo <clone>
node bin/bench.ts run v2 <case> <set> --repo <clone> --point opencode:luna --repeat 1
node bin/bench.ts score v2 <case> <set> --repo <clone> --point opencode:luna --repeat 1
node bin/bench.ts judge v2 <case> <set> --point opencode:luna --repeat 1
```

`import` keeps a reference as an imported run. `run` starts a new attempt in the slot, refuses a model without a list price, and ends with a `bench/arm` result. An attempt that fails for infra, or starts no run, is retried up to six attempts; after the last, an empty run at the base carries the infra result, so it counts as done. `score` imports and gates the references first, then writes `bench/setup`, `bench/size`, `bench/suite`, `bench/typecheck` and `bench/hidden`, offline except setup; `--drop-env` removes its environments. `judge` compares the run with the human run blind through `claude -p` and the `smart` alias and writes `bench/judge`; `--judges opus:1,sonnet:2` sets the panel and diff orders, and a judge from the contestant's maker is swapped. Each judge call lands at once as a `bench/judge` item with its verdict and cost, so a resume asks only the judges still missing, and the panel's result carries the cost of every call. `bench/judge.md` puts correctness first, then scope. <!-- code: bin/bench.ts#score bin/bench.ts#judge -->

Keys come from `--keys` (`infra/local/.keys.env`). Paid steps stop past `--max-codex` weekly Codex percent (90) or `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench <set> <set>
```

Bench is a built-in [studio page plugin](plugins.md#studio-pages) at `/bench`, always shown. It reads the run store of every instance the studio serves, plus the `data` store of each set named as above, through the plugin's [engine host](plugins.md#engine-access). Each run becomes a row: set runs one per slot from the newest attempt, instance runs one per run with an `instance` label. Labels become the filter and grouping axes, and scalar fields of the latest check results become columns. A field whose type or unit differs between stores is left out and named under the table. An earlier attempt that finished with `bench/hidden`, such as an older engine's migrated run, keeps its own row, and each row's cost and time cover only its attempts since the previous finished one. A set still in the old `runs/` layout shows nothing until `node bench/flatten.ts` moves it. <!-- code: studio/plugins.ts#readBenchConfigs studio/src/bench/plugin.ts bench/runs.ts#readBenchRows -->

The Bench tab plots each point. Quality is 0 for nothing useful and 1 for matching the human: hidden tests, judge preference (doubled, capped at 1) and suite scores, weighted by sliders, minus penalties. Cases without hidden tests form a `judge-only` point. Checking cost stays out of an arm's cost. Crosses show 95% intervals from 10 cases on. The staircase joins the points no cheaper point beats, and shows only when one case set is in view, since points on different sets do not compare. The names buttons choose which labels name the points; labels that cannot fit without overlap are hidden. Below the plot, one row per point, grouped by set, shows its label values, each case's mean over its repeats behind the point's mean, a band over the middle half of the cases with their median marked, and a hairline over every run with the run median marked (the tooltip names the case and run figures apart), cases, the share of runs passing hidden tests, cost per run as mean ± spread, and time. A picked row lists its runs, each linked to its trace: `/runs/<id>?data=<set data dir>` for a set run, `/<instance>/runs/<id>` for an instance run. The trace keeps `data` for its full logs, results and links, and the studio serves it only when the real path, after symlinks, is inside a bench dir. Check fields are summed per point below the rows.

Each row has one `labels` map containing case attributes, explicit case labels, free run labels, and the harness, model, arm, engine, graph and set. Case attributes override free labels. Generated run attributes override both.

`agents-md`, `claude-md` and `skills` are `true` or `false` from read-only `git ls-tree` at the case base commit. Skills include `.claude/skills`, `.agents/skills`, `.cursor/rules` and `.github/skills`. Scores save them in the `bench/setup` result.

<!-- code: bench/runs.ts#readBenchRows bin/bench.ts#readBenchSetupLabels studio/src/results/result.ts#readBenchRowResults -->

The Bench controls discover every label key. URL `where` is a JSON object of label keys to allowed value arrays, `by` is a comma-separated list of grouping keys, and `color` is a label key (empty means no colour). Values within a filter are alternatives; all filtered keys must match. Colour also splits points. For example, `/bench?where=%7B%22repo%22%3A%5B%22stx-labs%2Fexplorer%22%5D%7D&by=model,graph&color=skills` compares model and graph on explorer, coloured by skill presence. Judge-only cases and different sets always stay separate. Omitting `by` groups by harness, model, arm, engine, graph and set; an empty `by` combines them within each set.

<!-- code: studio/src/bench/score.ts#summarise studio/src/bench/BenchPage.tsx#BenchPage studio/src/bench/Forest.tsx#Forest -->

The x axis also lists row fields and labels whose values are finite numbers on every row contributing a score under the current filters, weights, judges and infra setting. Blank or missing values on those rows exclude a field. If the selected field becomes unavailable, the plot falls back to cost and an inline note names the field; the controls stay usable. Numeric axes are linear, named after the field, and averaged over repeats within each case, then over cases, like minutes. For example, `x=graph-words` plots a numeric run label; filtering, grouping and colouring still use its string value. <!-- code: studio/src/bench/score.ts#getBenchNumbers studio/src/bench/score.ts#findBenchNumericFields -->

For graph-size experiments, run the optional script from a clone:

```sh
node bench/graph-size.ts <set>...
node bench/graph-size.ts <set> --git-dir <repo>
```

It writes ordinary labels: `graph-words` counts whitespace-separated tokens in Markdown under `prompts/`, `agents/`, `skills/`, `workflows/` and `checks/`, including frontmatter; `graph-checks` counts check Markdown files; `graph-script-lines` counts nonblank lines in every file under `scripts/`. It excludes `node_modules/`. Counts use the attempt's graph copy even without `graphTree`, or the run's `graphTree` in its local git repository (use the second form for another repository). Git reads never fetch missing objects. Trees are cached within a pass, and an available graph copy takes precedence; unchanged labels add no entries. Imported references, runs without a graph copy and the tree or repository needed for recovery, and unreadable local graph objects are counted as skips with a one-line reason. This script is outside the published package. <!-- code: bench/graph-size.ts#readGraphSize bench/graph-size.ts#writeGraphSizeLabels -->

## Long runs

Rerun the same command after an interruption: runs whose slot is done are skipped, and one that ended without a result starts a new attempt beside the old one. Low disk [holds work](sandbox.md#disk). Ctrl-C or `kill <pid in start-runs.lock>` stops. One `start-runs` works per set, and it exits 1 while runs are left.

`node bench/flatten.ts <set>... [--dry]` moves a set of the earlier `runs/<slot>/<k>/` layout into attempts and one store. Attempts are numbered by slot name, then `k`. Each run is copied with `attempt` added to its origin input and its labels, and `set` when missing. Logs and environment refs are merged. It builds under `<set>/.flatten/` and renames into place, refuses a set that already has `attempts/` or `data/` or two runs with one id, and leaves `runs/` as it was. <!-- code: bench/flatten.ts#readFlatSetPlan bench/flatten.ts#writeFlatSet -->

`sh bin/overnight.sh <queue>` runs a file of commands, each up to three times; `sh bin/overnight.sh status <queue>` shows progress. Keep queues out of `/tmp`. Tunes live under `AGENTGRAPH_TUNE` (`~/.agentgraph/tune`); `node bin/tune.ts status <tune dir>` shows one.

A tune dir is a bench set. Each graph it tries is a variant with a control run `tune-<variant>` in `<tune dir>/data`, workflow `tune`, labelled `tune`, `iteration`, `variant` and `proposer`. Its `tune/proposal` check holds the rationale and the graph diff against its parent; `tune/decision` holds the verdict, why and the evaluations, and adds a `verdict` label; `tune/test` holds each test split evaluation. The variant's bench runs carry the same `tune`, `variant` and `iteration` labels, so on the Runs page a label links to its control run. Graphs are commits `refs/variant/<id>` in `<tune dir>/graph.git`. <!-- code: tune/runs.ts#writeVariantRun tune/runs.ts#readTuneSteps -->

`node tune/migrate.ts <tune dir>... [--dry]` moves a flattened tune dir of the earlier `iterations.jsonl` layout to control runs. It renames the `cand` label to `variant` in attempt and run inputs and in run labels, adds `tune` and `iteration`, moves `refs/cand/*` to `refs/variant/*` and renames `iterations.jsonl` and `phase.json` to `*.migrated`. It refuses a dir without `graph.git` or `data/`, or one that already has control runs; run `bench/flatten.ts` first. <!-- code: tune/migrate.ts#readTuneMigration tune/migrate.ts#writeTuneMigration -->
