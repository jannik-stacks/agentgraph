# Bench

Bench replays merged pull requests from their parent commits and issues, using hidden tests and blind judges to compare workflows. The runner and scorer are part of the engine clone (`bin/bench.ts`, `bench/`); the studio page is an example plugin loaded with `--plugins`.

## Run a set

A case is an issue and merged pull request to replay; an arm is a workflow to compare, and a point selects a harness and model. A set folder contains `set.json`, `cases/` and the resulting runs.

```sh
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --arms v2,floor --keys <keys file>
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --dry
```

The driver runs each case, arm, point and repeat, then scores it. `--cases` narrows the cases, `--graph` selects a graph and `--label k=v` distinguishes comparisons. It checks model readiness and prices before starting.

Each attempt has its own graph and tracker under `attempts/<n>/`; runs share `<set>/data/`. Sessions cannot read another attempt's tracker or the references. Graph changes and labels create separate slots; engine and harness upgrades require a label to rerun existing slots. The driver reports version differences without rerunning them.

The `human` and `base` references are imported runs of the merged change and no change. Scorers append `bench/*` check results without tracker writes. Run labels describe the case, arm, model, repeat and attempt; version labels come from the run record. <!-- code: bin/bench.ts#whyPointUnready bench/runs.ts#isBenchRunDone --> <!-- code: bench/start-runs.ts#formatStaleSlots --> <!-- code: bench/runs.ts#getBenchSlot bench/runs.ts#makeBenchAttempt bench/runs.ts#readBenchSlots bin/bench.ts#runArm bin/bench.ts#writeAttemptImport src/engine.ts#makeEngineHost -->

## Cases

Each case folder holds `case.json`, `issue.md` and `merged.diff`; optional `hidden.relaxed.diff` loosens tests that require more than the issue asks.

| Field                                          | Meaning                                                      |
| ---------------------------------------------- | ------------------------------------------------------------ |
| `repo`, `base`, `merged`                       | Repository and commits to replay                             |
| `test`, `suite`, `typecheck`, `setup`, `build` | Commands; `suite` defaults to `test`                         |
| `image`                                        | Local image for the arms and scoring                         |
| `hasTests: false`                              | Judge and metric scoring; hidden tests visibly skipped       |
| `size`, `kind`, `area`, `labels`               | Case labels                                                  |
| `control`                                      | `bug` flips an added comparison; `padded` adds trivial tests |

Case commands override repository recipes. Hidden tests must fail on base and pass on the merged change; the merged change must also apply and pass setup, suite and typecheck. Invalid cases and skipped tests record reasons.

Image selection uses case `image`, graph `image`, then the operator fallback and stock sandbox. Bench pins the Docker ID for resumes; a labelled comparison selects its own ID. Scoped cleanup preserves live environments and pins; insufficient disk holds work. <!-- code: bin/bench.ts#readCaseImage src/docker.ts#readImage --> <!-- code: src/disk.ts#collect src/disk.ts#ensureFreeDisk -->

## Arms

These are benchmark choices, rather than required engine workflows:

| Arm     | What runs                                             |
| ------- | ----------------------------------------------------- |
| `human` | The merged change                                     |
| `v2`    | The repository's example graph, else `examples/bench` |
| `floor` | `bench/floor`: one session without checks or review   |

Agent arms start from base with the fix hidden. A scripted maintainer answers one question; a second ends the arm. Infrastructure failures stay out of score rates, and an arm that changes nothing scores zero.

## Commands

Run individual stages from the clone:

```sh
node bin/bench.ts import human <case> <set> --repo <clone>
node bin/bench.ts run v2 <case> <set> --repo <clone> --point opencode:luna --repeat 1
node bin/bench.ts score v2 <case> <set> --repo <clone> --point opencode:luna --repeat 1
node bin/bench.ts judge v2 <case> <set> --point opencode:luna --repeat 1
```

`import` saves a reference, `run` starts an attempt, `score` gates references and measures the change, and `judge` compares it blindly with the human change. `--judges opus:1,sonnet:2` chooses the panel; `none` skips judges. Finished judge calls survive a resume.

Keys come from `--keys`; paid steps stop at `--max-codex` or `--max-claude-calls`. <!-- code: bin/bench.ts#score bin/bench.ts#judge -->

## Cost against quality

The studio page is an example plugin in `examples/plugins/bench`. Load it from the clone:

```sh
agi studio --plugins examples/plugins/bench
```

Open `/plugins/bench`. It reads served instances and the sets listed as absolute paths in `plugins.bench.sets` in the plugin folder's `settings.yaml`; see the [plugin README](../examples/plugins/bench/README.md).

Labels provide filters and grouping; check fields provide scores. Quality combines hidden tests, judge preference and suite results with adjustable weights. Judge-only cases and different sets stay separate. Cost excludes scoring, and the staircase joins points no cheaper point beats. Rows link to each run's trace.

Label a run `exclude=<reason>` to exclude it; remove the label to undo. Served runs have an exclude button. Read-only `?data=` runs copy a command instead: `agi label <store>/<run> 'exclude=reason'`. Exclusions leave points, rows, Results and all counts and denominators. The Excluded control lists reasons and can include them again. Labels record when, not who. <!-- code: bench/score.ts#isBenchMatch bench/score.ts#formatBenchLabelCommand examples/plugins/bench/plugins/bench/Forest.tsx#BenchExcludeButton -->

Version labels, case attributes and run labels describe each row. Numeric fields and labels can replace cost on the x axis when every scored row has a finite value. `node bench/graph-size.ts <set>...` adds graph word, check and script-line counts; unavailable graph sources are counted as skips with reasons. <!-- code: bench/runs.ts#makeSetHost bench/runs.ts#readBenchData bench/runs.ts#readBenchRows --> <!-- code: src/labels.ts#makeVersionLabels --> <!-- code: bench/runs.ts#readBenchRows bin/bench.ts#readBenchSetupLabels bench/score.ts#readBenchRowResults --> <!-- code: bench/score.ts#summarise examples/plugins/bench/plugins/bench/BenchPage.tsx#BenchPage examples/plugins/bench/plugins/bench/Forest.tsx#Forest --> <!-- code: bench/score.ts#getBenchNumbers bench/score.ts#findBenchNumericFields --> <!-- code: bench/graph-size.ts#readGraphSize bench/graph-size.ts#writeGraphSizeLabels -->

## Long runs

Rerun the same command after interruption: finished slots are skipped and incomplete ones get another attempt. One driver runs per set; Ctrl-C stops it. [Low disk](sandbox.md#disk) holds work.

`node bench/flatten.ts <set>... [--dry]` converts older set layouts into attempts and a shared store. `sh bin/overnight.sh <queue>` runs a command queue with retries. <!-- code: bench/flatten.ts#readFlatSetPlan bench/flatten.ts#writeFlatSet -->

## Tune

Tune is an experimental clone-only tool that tests graph changes through Bench, with little test coverage and unstable commands and files. Submit a candidate with `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`.
