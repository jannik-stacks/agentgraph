# tune-graph

A Claude Code skill that tunes a bothub hub on one repo. `SKILL.md` is the skill; `scripts/status.sh`
prints one screen on a tune: the incumbent, the last 5 steps and the budget left. Copy the folder into
`~/.claude/skills/` or a repo's `.claude/skills/` to install it.

## Benchmark

The skill is measured against the plain tune loop (`node bin/tune.ts run`) on the same data, so the
only difference is who proposes the candidates.

- `tune/skill.ts` runs it. It copies the loop tune's `tune.json`, cases and starting hub into
  `skill@<version>` beside it, so cases, splits, point, engine and keep rule are the same, and the
  starting score comes from the bench cache.
- Each round is one `claude -p --restricted` session with the skill loaded as the plugin
  `bothub:tune-graph`, in `skill@<v>/skill/r<NNN>/`. That folder holds the incumbent, the fit and mine
  cases, the incumbent's fit runs, `tried.md` with held-out ids redacted, and `out/d1` to `out/d<k>`.
  File tools cannot reach outside it and there is no shell. Tool calls that name a held-out case
  or a tune path outside the folder are listed in `round.json` as `leaks`.
- The harness checks each slot's hub, queues it with `tune propose --as skill`, then runs
  `tune step --proposers manual`. The loop's stop rules apply: the round count, 3 flat rounds, no
  proposal, the caps.
- Usage: Codex per step from `step` as in the loop, Claude 5h points of the session shared by the
  round's candidates (the screen eval's `claude5h`), the session's usd and minutes in `round.json`.
- Resume: rerun the same command. A round with `round.json` is not asked again; its candidates are
  evaluated. A half-done session folder is kept as `r<NNN>.<time>` and asked again. A changed
  `SKILL.md` refuses to resume; bump the version.
- Same budget: 6 rounds against the loop's `--iterations 6`, with the same caps.
- Bump the version when `SKILL.md` changes in a way that could move the score.

```sh
node tune/skill.ts ~/bothub-data/tune/stacks.js/t1 --version 1 --rounds 6 --k 4 --parallel 2 \
  --max-codex 25 --max-claude-5h 40 --max-claude-week 12 --keys infra/local/.keys.env
```

`--stop-claude-5h` and `--stop-claude-week` also stop at an absolute reading, in percent.

The Compound tab shows each tune as a series, `<repo>/<name>`. Pick "average" and the series `skill@1`
and the loop's tune: per iteration, the mean over repos of the running best, with the per-repo range as
a band. Compare at equal iterations and at equal spend (toggle the x axis to cumulative usd).

What counts: the select score after 6 rounds, the test score at the last checkpoint, and the spend to
get there. The skill wins when its test score is higher at the same or lower spend. A select gain that
the test split does not show is overfitting, not a win. One repeat per side is noise-prone; a difference
under the keep delta (0.03) is a tie.
