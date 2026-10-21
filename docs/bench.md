# Bench

The bench replays merged pull requests. Each arm gets the issue text at the merge's parent commit, and
its result is scored against what was merged, first by tests and then by a blind panel of judges.

## Run it at a commit

```sh
BENCH_CASES=<miner cases> BENCH_REPOS=<clones> npm run bench -- --at <engine-commit> [--set smoke] [--fresh]
```

It checks the commit out as a git worktree under `runs/<sha>/engine`, runs every case of
`bench/sets/<set>.json` (validity, v2, floor, score, judge) with that engine, and writes
`runs/<sha>/report.md` and `compare.md`, the headline numbers that changed against the newest earlier
report. `--cases-dir`, `--repos-dir`, `--out` (default `runs`), `--parallel` (default 3) and `--judges`
override the defaults. A set pins each case's `base`; a case whose folder has another base is skipped.

`--point harness:model` (or `BENCH_POINT`) runs every agent of the hub copy on that harness and model, and `--repeat k` runs
a case again instead of reusing it. Either puts the run in `runs/<sha>/<harness>-<model>/r<k>`, with a
`point.json` that names the harness, model, engine, hub trees, set and repeat. When the keys file has
`BOTHUB_LLM_API_KEY_PT_<HARNESS>_<MODEL>`, every agent uses that key. `--pairs human` judges each arm
against the human only.

Nothing unchanged is run or judged again. Results live in `runs/.cache`: validity by case, an arm by
case, arm, hub content and the engine's `src` tree (the floor arm leaves the tree out), and the point and
repeat when given, a judge verdict by
judge and prompt, which holds both diffs and their order. `--fresh` ignores the cache.

## Cases

A case is a folder with `case.json`, `issue.md` and `merged.diff`. `case.json` names the repo, the
`base` (the parent commit) and the `merged` commit. The commands are optional: `test` runs the tests
the merged change adds, `suite` the whole suite (it falls back to `test`), `typecheck`, and `setup`
before them. A case with `hasTests: false` gets no test runs, only metrics and judges. Strata fields
such as `size`, `kind` and `area` group the report.

A case counts only when the hidden tests fail on the base and pass on the human, and the human diff
applies, its setup works and its suite passes. Otherwise `valid.json` says why, the case's arms are not
run or judged, and the report lists it as invalid. A case with `control: bug` or `control: padded`
judges the human diff against a copy of itself instead of the arms: `bug` flips one comparison in an
added source line, `padded` appends a test file of trivial cases. Judges that prefer the copy are
wrong, which measures how well they catch bugs and how much they reward size.

## Arms

- `human`: the merged change.
- `v2`: the engine with the repo's hub (`examples/clarinet`, `examples/sk`, `examples/sandbox`), or
  `examples/bench` for any other repo: an implementor that must pass the case's `test` command, then a
  reviewer that may send it back once (skipped for one small edit to one source file), then a human
  merge.
- `floor`: one plain session in the same hub's sandbox and budget, no checks and no review
  (`bench/floor`).
- `v1`: not yet. It needs its own sandbox image and env, and its seed must be made leak-free first.

An arm run that ends with an empty diff, a run that never finished or a crash is infra, not a result.
It is retried once, and if it fails again `meta.json` says why and the arm is left out of every win rate
and mean, and listed in the report. A setup failure while scoring counts the same way.

Each run seeds a forge folder with `node bin/forge.ts <dir> init <repo> --at <base>`, so the fix is not
in the origin. When a run asks a question, a scripted maintainer answers once with "No more
information. Use your judgment." and the answer is counted.

## Commands

```sh
node bin/bench.ts run v2 <case> <out> --repo <clone>
node bin/bench.ts run floor <case> <out> --repo <clone>
node bin/bench.ts score <case> <out> --repo <clone>
node bin/bench.ts judge <case> <out>
node bin/bench.ts report <out>
```

- `run` leaves the arm's forge, data dir, hub copy, `diff.patch`, `meta.json` and `usage.json` (sessions,
  reported cost and tokens by model and class) in `<out>/<case>/<arm>`. A cached arm keeps `usage.json`
  but not its data dir. `--point` and `--repeat` work as above.
- `score` checks each arm out at the base in one shared tree, applies its diff and runs the suite and
  typecheck. Then it puts the merged change's test files on top and runs `test`: those are the hidden
  tests. A `base` row shows whether they fail before any change. It also counts source and test lines,
  files, overlap with the human's files, added test cases, the change in branch tokens, and sessions,
  cost and answers from `usage.json`, else the traces.
- `judge` hands every pair of arms to three judges (Opus and Sonnet through `claude -p`, sol through
  LiteLLM's `smart`). `--judges opus:1,sonnet:2,sol:2` sets how many orders each reads; a judge with
  one reads the order picked by the case and pair, so a pair costs three Claude calls. `--pairs human`
  judges only the pairs with the human in them. The diffs are blinded: no lockfiles or changelogs, no index
  lines, issue numbers and names masked. The prompt is `bench/judge.md`: correctness against the issue
  first, then scope, and more tests or lines are not better in themselves. Each verdict lists findings
  by severity and category, a preference, and is kept as JSON next to the raw answer.
- `report` writes `report.md`: the valid, invalid and infra counts, the hidden test pass rate per arm,
  then win rates with a bootstrap interval over cases, mean metrics per arm,
  findings by severity, judge agreement, all of it again per stratum, and a table per case.

Every step skips outputs that exist and moves an unfinished arm aside instead of deleting it. Progress
goes to `<out>/log.jsonl`. `BENCH_PATH` is put in front of `PATH` for the score step's commands, for a
Node version the repo's `engines` asks for. A mined `case.json` lists its test files in `tests` and has no
commands: the bench derives them per repo (`plan` in `bin/bench.ts`), and `bucket: no-tests` means
metrics and judges only. Model keys come from `--keys`, `infra/local/.keys.env` by default. Before a
paid step the bench reads the weekly Codex use and stops once it is more than `--max-codex` points (30)
above the first reading, or after `--max-claude-calls` judge calls (60).

## Cost against quality

```sh
cd studio && npm run dev -- --bench ~/bothub-data/bench/runs-2 ~/bothub-data/bench/runs-3
```

The studio's Bench tab plots each point, a harness and model on an arm and a set, as quality against
notional USD per task or minutes. It reads every out dir under the dirs it is given; a dir without
`point.json` reads as opencode on `smart`, repeat 1, with the dir name as its set. Quality is 0 for nothing
useful and 1 for the human: the hidden tests, twice the judges' preference over the human and the suite,
weighted by the sliders, less penalties for findings above the human's and for questions. Cost is the
tokens priced from `infra/local/prices.json`. Crosses are 95% intervals from a bootstrap over cases, then
repeats. The staircase through the points no cheaper point beats shows once each of them has 10 valid
cases. Click a point for its cases.
