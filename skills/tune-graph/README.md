# tune-graph

A Claude Code skill that tunes a bothub hub on one repo. `SKILL.md` is the skill; `scripts/status.sh`
prints one screen on a tune: the incumbent, the last 5 steps and the budget left. Copy the folder into
`~/.claude/skills/` or a repo's `.claude/skills/` to install it.

## Benchmark

The skill is measured against the plain tune loop (`node bin/tune.ts run`) on the same data, so the
only difference is who proposes the candidates.

- Same repos and splits as the loop's tunes: stacks.js and clarinet, the same `splits.gated.json`.
- Same engine sha, same point, same keep rule.
- Same budget: 6 rounds, the loop with `--iterations 6`. Each side records its usage per step.
- The skill runs with the tune name `skill@<version>`, starting at `skill@1`, so each repo gets
  `~/bothub-data/tune/<repo>/skill@1/`. Bump the version when `SKILL.md` changes in a way that could move
  the score; an old series stays as it is.
- The skill answers its own step 1 with these settings and skips step 7's adoption question.

The Compound tab shows each tune as a series, `<repo>/<name>`. Pick "average" and the series `skill@1`
and the loop's tune: per iteration, the mean over repos of the running best, with the per-repo range as
a band. Compare at equal iterations and at equal spend (toggle the x axis to cumulative usd).

What counts: the select score after 6 rounds, the test score at the last checkpoint, and the spend to
get there. The skill wins when its test score is higher at the same or lower spend. A select gain that
the test split does not show is overfitting, not a win. One repeat per side is noise-prone; a difference
under the keep delta (0.03) is a tie.
