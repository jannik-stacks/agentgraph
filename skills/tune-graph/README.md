# tune-graph

A Claude Code skill that tunes one repo's graph. Copy the folder into `~/.claude/skills/` or a repo's
`.claude/skills/` to install it. `node bin/tune.ts status` shows a tune on one screen.

## Benchmark

The skill is measured against the plain tune loop (`node bin/tune.ts run`) on the same data, so only the
proposer differs. `tune/skill.ts` copies the loop tune's `tune.json`, cases and starting graph into
`skill@<version>` beside it.

- Each round is one `claude -p --restricted` session with the skill as the plugin `agentgraph:tune-graph`, in
  `skill@<v>/skill/r<NNN>/`. File tools cannot leave that folder and there is no shell. Tool calls naming a
  held-out case or an outside tune path are listed in `round.json` as `leaks`.
- The harness checks each slot, queues it with `tune propose --as skill`, then runs `tune step --proposers
  manual`. The loop's stop rules and caps apply; 6 rounds match the loop's `--iterations 6`.
- `round.json` records the session's Claude points, usd and minutes. Rerun the same command to resume; a
  changed `SKILL.md` refuses to resume, so bump the version.

```sh
node tune/skill.ts ~/.agentgraph/tune/stacks.js/t1 --version 1 --rounds 6 --k 4 --parallel 2 \
  --max-codex 25 --max-claude-5h 40 --max-claude-week 12 --keys infra/local/.keys.env
```

`--stop-claude-5h` and `--stop-claude-week` also stop at an absolute reading, in percent.

The Results tab with `from=tune` shows every candidate of every tune. In the chart, put `tune quality` on y,
`iteration` on x and color by `tune`: the kept candidates draw each tune's staircase. Facet by `repo` to
compare per repo, and put `tune usd` on x to compare at equal spend per run.

The skill wins when its test score at the last checkpoint is higher at the same or lower spend. A select
gain the test split does not show is overfitting. A difference under the keep delta (0.03) is a tie.
