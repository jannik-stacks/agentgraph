# Bench

The bench replays merged pull requests from their parent commit and issue. Hidden tests and blind judges score each arm against the merged change.

## Run a set

A set dir holds `set.json` and `cases/`. Every bench result is a run: an arm's session is an engine run, and the `human` and `base` references are [imported runs](runs.md) of the merged change and of no change. Scorers and judges add `bench/*` results to a run's `checks.jsonl` as later entries whose version is the scorer's hash, and never touch a forge. `bench/start-runs.ts` starts the runs a plan names and skips the ones already on disk:

```sh
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --arms v2,floor --keys <keys file>
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --dry
```

A plan is every case of `set.json` times each arm, point and repeat, with `--cases`, `--graph <dir>` and any `--label k=v`. Each unit gates its case on the references, then runs, scores and judges its slot through `bin/bench.ts` (`--judges`, default `opus:1,sonnet:2`; `none` skips). Points take aliases such as `opencode:glm` ([OpenRouter](../infra/local/README.md#openrouter-models)). Before any unit starts it names every queued point that has no list price or that the model proxy refuses a one-line request with the key its agents get. Logs go to `<set>/logs/<case>-<arm>-<point>-r<k>.log`. <!-- code: bin/bench.ts#whyPointUnready bench/runs.ts#isBenchUnitDone -->

A run's identity is its origin input: case, arm, repeat, point, the tree hash of the graph it runs (the repo's example graph unless `--graph` names one, plus `bench/floor` for floor) and any `--label k=v`, so changing the graph or a label starts new runs. The engine is not part of it: to rerun an older engine, run from its worktree into another set, or pass a label. It picks the slot `<set>/runs/<case>-<arm>-r<k>-<hash>/`, where each attempt gets its own numbered dir with the graph, a tracker and the run data. References are one slot per case at repeat 1. A unit is done when its case is invalid, its arm failed for infra, or its slot has `bench/hidden` and, when judged, `bench/judge`. Scores land in one append, and a run that changed nothing gets a `bench/judge` marked n/a. [Run labels](runs.md#run-labels) record the same and more: `bench run` adds `case`, `arm`, `harness`, `model`, `repeat`, `engine` (its commit) and the `--label` pairs. <!-- code: bench/runs.ts#getBenchSlot bin/bench.ts#runArm bin/bench.ts#writeReferenceRun -->

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

`import` keeps a reference as an imported run. `run` starts a new attempt in the slot, refuses a model without a list price, and ends with a `bench/arm` result. An attempt that fails for infra, or starts no run, is retried up to six attempts; after the last, an empty run at the base carries the infra result, so the unit counts as done. `score` imports and gates the references first, then writes `bench/setup`, `bench/size`, `bench/suite`, `bench/typecheck` and `bench/hidden`, offline except setup; `--drop-env` removes its environments. `judge` compares the run with the human run blind through `claude -p` and the `smart` alias and writes `bench/judge`; `--judges opus:1,sonnet:2` sets the panel and diff orders, and a judge from the contestant's maker is swapped. `bench/judge.md` puts correctness first, then scope. <!-- code: bin/bench.ts#score bin/bench.ts#judge -->

Keys come from `--keys` (`infra/local/.keys.env`). Paid steps stop past `--max-codex` weekly Codex percent (90) or `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench <runs dir> <runs dir>
```

Bench is a built-in [studio page plugin](plugins.md#studio-pages) at `/bench`. It is registered only when the studio starts with bench dirs, as above, so without them there is no Bench tab. Its reader turns every bench run under those dirs into a row, one per slot from its newest attempt, and watches those dirs. <!-- code: studio/plugins.ts#makeStudioPagesPlugin studio/src/bench/read.ts#readBench bench/runs.ts#readBenchRows -->

The Bench tab plots each point. Quality is 0 for nothing useful and 1 for matching the human: hidden tests, judge preference (doubled, capped at 1) and suite scores, weighted by sliders, minus penalties. Cases without hidden tests form a `judge-only` point. Checking cost stays out of an arm's cost. Crosses show 95% intervals from 10 cases on. The staircase joins the points no cheaper point beats, and shows only when one case set is in view, since points on different sets do not compare. The names buttons choose which labels name the points; labels that cannot fit without overlap are hidden. Below the plot, one row per point, grouped by set, shows its label values, each case's mean over its repeats behind the point's mean, a band over the middle half of the cases with their median marked, and a hairline over every run with the run median marked (the tooltip names the case and run figures apart), cases, the share of runs passing hidden tests, cost per run as mean ± spread, and time. A picked row lists its runs, each linked to its trace at `/runs/<id>?data=<run data dir>`. The trace keeps `data` for its full logs, results and links, and the studio serves it only when the real path, after symlinks, is inside a bench dir. Check fields are summed per point below the rows.

Each row has one `labels` map containing case attributes, explicit case labels, free run labels, and the harness, model, arm, engine, graph and set. Case attributes override free labels. Generated run attributes override both. `node bin/results.ts bench` exports the rows as a result sheet with every label as an axis; its point axis is a display grouping when no explicit point label exists.

`agents-md`, `claude-md` and `skills` are `true` or `false` from read-only `git ls-tree` at the case base commit. Skills include `.claude/skills`, `.agents/skills`, `.cursor/rules` and `.github/skills`. Scores save them in the `bench/setup` result.

<!-- code: bench/runs.ts#readBenchRows bin/bench.ts#readBenchSetupLabels studio/src/results/result.ts#readBenchRowResults -->

The Bench controls discover every label key. URL `where` is a JSON object of label keys to allowed value arrays, `by` is a comma-separated list of grouping keys, and `color` is a label key (empty means no colour). Values within a filter are alternatives; all filtered keys must match. Colour also splits points. For example, `/bench?where=%7B%22repo%22%3A%5B%22stx-labs%2Fexplorer%22%5D%7D&by=model,graph&color=skills` compares model and graph on explorer, coloured by skill presence. Judge-only cases and different sets always stay separate. Omitting `by` groups by harness, model, arm, engine, graph and set; an empty `by` combines them within each set.

<!-- code: studio/src/bench/score.ts#summarise studio/src/bench/BenchPage.tsx#BenchPage studio/src/bench/Forest.tsx#Forest -->

## Long runs

Rerun the same command after an interruption: units whose slot is done are skipped, and a unit whose run ended without a result starts a new attempt beside the old one. Low disk [holds work](sandbox.md#disk). Ctrl-C or `kill <pid in start-runs.lock>` stops. One `start-runs` works per set, and it exits 1 while units are left.

`node bench/migrate.ts <old bench dir> <set> --repos <clones>` copies a bench dir of the earlier `diff.patch` and `score.json` layout into slots, cloning files where the disk can, with its results at version `migrated`. Each engine and graph of the old dir keeps its own slot, every earlier attempt becomes an attempt, and an arm saved without its run data becomes an imported run of its patch that keeps the recorded cost. A dir without `point.json` reads as `opencode:smart`, repeat 1, with its name as the set. Infra follows the old reader: an empty diff is the agent's result, a failed setup is infra. Each slot is built under `runs/.migrating/` and moved into place when complete, so an interrupted pass leaves no partial slot and the next pass finishes the rest. The old dir stays as it was. <!-- code: bench/migrate.ts#copyOldBenchRuns -->

`sh bin/overnight.sh <queue>` runs a file of commands, each up to three times; `sh bin/overnight.sh status <queue>` shows progress. Keep queues out of `/tmp`. Tunes live under `AGENTGRAPH_TUNE` (`~/.agentgraph/tune`); `node bin/tune.ts status <tune dir>` shows one.
