# Bench

Bench compares workflows by replaying an issue from the parent commit of its merged pull request. Hidden tests measure the result. Judges are agents that compare changes without seeing which workflow produced them. Run Bench from a clone and load its [studio page](#cost-against-quality) with `--plugins`. <!-- code: bin/bench.ts#runArm bin/bench.ts#score bin/bench.ts#judge examples/plugins/bench/plugins/bench.ts -->

## Run a set

A case pairs an issue with its merged pull request. An arm is a workflow to compare, and a point selects a [harness](index.md#terms) and model. A set folder contains `set.json`, `cases/` and the resulting runs. <!-- code: bin/bench.ts#readBenchCase bench/start-runs.ts bench/runs.ts#readBenchSlots -->

```sh
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --arms v2,floor --keys <keys file>
node bench/start-runs.ts <set> --points opencode:luna --repeats 3 --dry
```

The driver runs each case, arm, point and repeat, then scores it. `--cases` narrows the cases, `--graph` selects a graph and `--label k=v` distinguishes comparisons. It checks model readiness and prices before starting. <!-- code: bench/start-runs.ts bin/bench.ts#whyPointUnready -->

Each attempt has its own graph and tracker under `attempts/<n>/`. Runs share `<set>/data/`. Sessions cannot read another attempt's tracker or the references. Each combination of inputs identifies a comparison to run. Changing the graph or a label starts a separate comparison. If only the engine or harness version changes, the driver reports the difference. Add a label to run that comparison again. <!-- code: bench/runs.ts#getBenchSlot bench/runs.ts#makeBenchAttempt bench/start-runs.ts#formatStaleSlots bin/bench.ts#engineArm -->

Bench imports two reference runs, `human` for the merged change and `base` for the unchanged starting tree. Scorers append `bench/*` check results without tracker writes. Run labels describe the case, arm, model, repeat and attempt. Version labels come from the run record. <!-- code: bin/bench.ts#whyPointUnready bench/runs.ts#isBenchRunDone bench/start-runs.ts#formatStaleSlots bench/runs.ts#getBenchSlot bench/runs.ts#makeBenchAttempt bench/runs.ts#readBenchSlots bin/bench.ts#runArm bin/bench.ts#writeAttemptImport src/engine.ts#makeEngineHost -->

## Cases

Each case folder holds `case.json`, `issue.md` and `merged.diff`. An optional `hidden.relaxed.diff` loosens tests that require more than the issue asks. <!-- code: bin/bench.ts#readBenchCase bin/bench.ts#findHiddenTests -->

| Field | Meaning |
| --- | --- |
| `repo`, `base`, `merged` | Repository and commits to replay |
| `test`, `suite`, `typecheck`, `setup`, `build` | Case commands. The suite defaults to `test`. |
| `image` | Local image for the arms and scoring |
| `hasTests: false` | Bench scores with judges and metrics and records why it skipped hidden tests. |
| `size`, `kind`, `area`, `labels` | Case labels |
| `control` | `bug` flips an added comparison. `padded` adds trivial tests. |

<!-- code: bin/bench.ts#readBenchCase bin/bench.ts#check bin/bench.ts#writeAttemptImport -->

Case commands override repository recipes. Hidden tests must fail on the starting commit and pass on the merged change. The merged change must also apply and pass setup, the test suite and type checking. Bench records a reason for each invalid case or skipped test. <!-- code: bin/bench.ts#check bin/bench.ts#invalid -->

A case can override the [graph's image](sandbox.md#a-graphs-own-image). Bench pins the Docker image ID for resumed comparisons. A comparison with different labels gets its own pin. See [Disk](sandbox.md#disk) for cleanup and low-space settings. <!-- code: bin/bench.ts#readCaseImage src/docker.ts#readImage src/disk.ts#collect -->

## Arms

| Arm | What runs |
| --- | --- |
| `human` | The merged change |
| `v2` | The repository's example graph, or `examples/bench` as a fallback |
| `floor` | One session using `bench/floor`, without checks or review |

<!-- code: bin/bench.ts#writeArmGraph bin/bench.ts#writeAttemptImport -->

Agent arms start from the base commit with the fix hidden. A scripted maintainer answers one question. If the run asks again, the driver ends the attempt. By default, scoring excludes infrastructure failures. An arm that changes nothing scores zero. <!-- code: bin/bench.ts#engineArm bin/bench.ts#runArm bench/score.ts#quality bench/score.ts#getBenchScore -->

## Commands

From a clone, run each stage separately. <!-- code: bin/bench.ts -->

```sh
node bin/bench.ts import human <case> <set> --repo <clone>
node bin/bench.ts run v2 <case> <set> --repo <clone> --point opencode:luna --repeat 1
node bin/bench.ts score v2 <case> <set> --repo <clone> --point opencode:luna --repeat 1
node bin/bench.ts judge v2 <case> <set> --point opencode:luna --repeat 1
```

`import` saves a reference, `run` starts an attempt, `score` checks the reference results and measures the change, and `judge` compares it blindly with the human change. `--judges opus:1,sonnet:2` chooses the panel. Use `none` to skip judges. Finished judge calls survive a resume. <!-- code: bin/bench.ts#runArm bin/bench.ts#judge bin/bench.ts#score -->

Supply keys with `--keys`. Paid steps stop at `--max-codex` or `--max-claude-calls`. <!-- code: bin/bench.ts#score bin/bench.ts#judge -->

## Cost against quality

The studio page is an example plugin in `examples/plugins/bench`. Load it from the clone. <!-- code: examples/plugins/bench/plugins/bench.ts studio/dev.ts -->

```sh
agi studio --plugins examples/plugins/bench
```

Open `/plugins/bench`. It reads the served [instances](index.md#terms) and the sets listed as absolute paths in `plugins.bench.sets` in the plugin folder's `settings.yaml`. See the [plugin README](../examples/plugins/bench/README.md). <!-- code: examples/plugins/bench/plugins/bench.ts bench/runs.ts#readBenchData -->

Use labels to filter or group comparisons. Quality combines hidden tests, judge preferences and suite results with adjustable weights. Scoring costs are excluded. For a single set, the stepped line shows the best quality reached at or below each cost. A point raises the line only when it improves on every cheaper point. Cases scored only by judges stay off this line. Select a row to read its run trace. <!-- code: bench/score.ts#quality bench/score.ts#frontier examples/plugins/bench/plugins/bench/BenchPage.tsx#BenchPage -->

Use the Exclude button to label a run `exclude=<reason>`. A read-only store opened through `?data=` lets you copy a command instead, such as `agi label <store>/<run> 'exclude=reason'`. Excluded runs disappear from points, rows, Results and their counts. The Excluded control lists reasons and lets you include those runs again. Remove the label to undo the exclusion. Label edits record a time but no author. <!-- code: bench/score.ts#isBenchMatch bench/score.ts#formatBenchLabelCommand examples/plugins/bench/plugins/bench/Forest.tsx#BenchExcludeButton src/labels.ts#writeRunLabels -->

Version labels, case attributes and run labels describe each row. Numeric fields and labels can replace cost on the x axis when every scored row has a finite value. `node bench/graph-size.ts <set>...` adds graph word, check and script-line counts. If the graph source is unavailable, the command counts the skip and reports why. <!-- code: bench/runs.ts#makeSetHost bench/runs.ts#readBenchData bench/runs.ts#readBenchRows src/labels.ts#makeVersionLabels bin/bench.ts#readBenchSetupLabels bench/score.ts#readBenchRowResults bench/score.ts#summarise examples/plugins/bench/plugins/bench/BenchPage.tsx#BenchPage examples/plugins/bench/plugins/bench/Forest.tsx#Forest bench/score.ts#getBenchNumbers bench/score.ts#findBenchNumericFields bench/graph-size.ts#readGraphSize bench/graph-size.ts#writeGraphSizeLabels -->

## Long runs

After an interruption, rerun the same command. The driver skips finished comparisons and starts a new attempt for each incomplete one. Only one driver can run per set. Press Ctrl-C to stop it. <!-- code: bench/start-runs.ts bench/runs.ts#isBenchRunDone -->

`node bench/flatten.ts <set>... [--dry]` converts older set layouts into attempts and a shared store. `sh bin/overnight.sh <queue>` runs a command queue with retries. <!-- code: bench/flatten.ts#readFlatSetPlan bench/flatten.ts#writeFlatSet bin/overnight.sh -->

## Tune

Tune tests a candidate graph against the current graph through Bench. It is experimental, runs from a clone and has limited test coverage. Its commands and file formats may change. To submit a candidate, use `node bin/tune.ts propose <tune dir> --from <graph dir> --why <text>`. <!-- code: bin/tune.ts#propose bin/tune.ts#decide tests/tune.test.ts -->
