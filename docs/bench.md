# Bench

The bench replays merged pull requests. Each arm gets the issue text at the merge's parent commit, and
its result is scored against what was merged, first by tests and then by a blind panel of judges.

## Cases

A case is a folder with `case.json`, `issue.md` and `merged.diff`. `case.json` names the repo, the
`base` (the parent commit) and the `merged` commit. The commands are optional: `test` runs the tests
the merged change adds, `suite` the whole suite (it falls back to `test`), `typecheck`, and `setup`
before them. A case with `hasTests: false` gets no test runs, only metrics and judges. Strata fields
such as `size`, `kind` and `area` group the report.

## Arms

- `human`: the merged change.
- `v2`: the engine with the repo's hub (`examples/clarinet`, `examples/sk`, `examples/sandbox`), or
  `examples/bench` for any other repo, which runs the case's `test` command as its one check.
- `floor`: one plain session in the same hub's sandbox and budget, no checks and no review
  (`bench/floor`).
- `v1`: not yet. It needs its own sandbox image and env, and its seed must be made leak-free first.

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

- `run` leaves the arm's forge, data dir, hub copy, `diff.patch` and `meta.json` in
  `<out>/<case>/<arm>`.
- `score` checks each arm out at the base in one shared tree, applies its diff and runs the suite and
  typecheck. Then it puts the merged change's test files on top and runs `test`: those are the hidden
  tests. A `base` row shows whether they fail before any change. It also counts source and test lines,
  files, overlap with the human's files, added test cases, the change in branch tokens, and sessions,
  cost and answers from the traces.
- `judge` hands every pair of arms to three judges (Opus and Sonnet through `claude -p`, sol through
  LiteLLM's `smart`), in both orders. The diffs are blinded: no lockfiles or changelogs, no index
  lines, issue numbers and names masked. The prompt is `bench/judge.md`. Each verdict lists findings
  by severity and category, a preference, and is kept as JSON next to the raw answer.
- `report` writes `report.md`: win rates with a bootstrap interval over cases, mean metrics per arm,
  findings by severity, judge agreement, all of it again per stratum, and a table per case.

Every step skips outputs that exist and moves an unfinished arm aside instead of deleting it. Progress
goes to `<out>/log.jsonl`. Model keys come from `--keys`, `infra/local/.keys.env` by default. Before a
paid step the bench reads the weekly Codex use and stops once it is more than `--max-codex` points (30)
above the first reading, or after `--max-claude-calls` judge calls (60).
