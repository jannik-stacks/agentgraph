---
name: tune-graph
description: Tune the agentgraph graph of your own repo. Replays your merged pull requests, tries graph variants in parallel (graph structure, checks, skill lines) and keeps the ones that score higher, then shows you the result against the human and on held-out cases. Use when someone wants to improve or tune their agentgraph graph or workflows for a repo.
---

# Tune a graph on your repo

A graph is what agentgraph runs on your issues, kept in `.agentgraph/`: steps, checks, agents and skills. This skill finds a
better one for your repo. It replays issues your team already solved, runs a graph on each, and scores
the result against what the human merged. A score of 1 means as good as the human on the hidden tests.

Each round, a few subagents each try one change to the current best graph. `bin/tune.ts` runs them all
and keeps a change only when it wins clearly on cases the subagents never saw. You stop when the budget
runs out or nothing wins three rounds in a row. Then you explain the final graph to the user.

## Rules

- Never write to the user's checkout. Read it at most. Every clone, case, graph and run lives under
  `~/.agentgraph/` or in docker. Before you start and before you finish, run `git status` in the user's
  checkout and say so if anything changed.
- Mining is read-only: GitHub GET calls and fresh clones under `~/.agentgraph/`. No GitHub writes.
- The user approves the plan (repo, model point, budget) before the first run, and approves the final
  graph before it goes anywhere. You hand over a folder and a diff; the user puts it in `.agentgraph/`.
- Never change the engine. Only graph files: agents, skills, checks, scripts, workflows, `settings.yaml` limits.
- Subagents never read validate or test cases, their traces or their scores. Only fit and mine cases.
- Keep everything. Drafts, candidates and runs stay on disk.

Run every command from a agentgraph checkout. `T` is the tune dir,
`~/.agentgraph/tune/<repo>/<name>`.

## 1. Plan with the user

Ask for the repo (`owner/name`), the model point (default `opencode:luna`), the number of rounds
(default 6) and the caps (default `--max-codex 25 --max-claude-5h 40 --max-claude-week 12`). Say what
a round costs: about 30 case runs, 25 minutes with 6 in parallel. Wait for a yes.

## 2. Gather the history

Reuse cases if `~/.agentgraph/bench/cases` or `~/.agentgraph/tune-repos/cases` already has the repo:
copy them with their `splits.json` into `~/.agentgraph/tune/<repo>/`. Otherwise mine:

```sh
node ~/.agentgraph/bench/tools/mine.mjs <owner/name> ~/.agentgraph/tune/<repo>
node ~/.agentgraph/bench/tools/finalize.mjs ~/.agentgraph/tune/<repo>
```

That gives one case per merged PR with a linked issue (`case.json`, `issue.md`, `merged.diff`,
`reviews.md`), a clone in `repos/`, and `splits.json`: oldest 60% train, then 20% validate, newest 20%
test. Gate the cases with tests, no model calls:

```sh
node bin/bench.ts score ~/.agentgraph/tune/<repo>/cases/<id> ~/.agentgraph/tune/<repo>/gate --repo ~/.agentgraph/tune/<repo>/repos/<repo>
```

Keep a case only when its `valid.json` says the hidden tests fail on the base and pass on the human.
Write `splits.gated.json` with just those. You need about 12 fit plus validate cases and 5 test cases.
With fewer, tell the user the numbers will be noisy and ask whether to go on.

## 3. Start from a minimal graph

```sh
node bin/tune.ts init <repo> --cases ~/.agentgraph/tune/<repo>/cases --splits ~/.agentgraph/tune/<repo>/splits.gated.json --repos ~/.agentgraph/tune/<repo>/repos --point opencode:luna --name <name>
```

`init` writes the minimal graph (implement with `tries: 2` and a tests check, then a human merge), scores
it on fit and validate, and records it as the incumbent. Train is split in two: mine (oldest half,
never run, read for history) and fit (run every round). Run `node bin/tune.ts status T` and show the user
the starting score.

## 4. One round

Read the incumbent graph at `T/cands/<id>/graph` (the last `kept` line of `T/iterations.jsonl`), the traces
and diffs of its fit cases that scored below 1 under `T/runs/<id>/`, and the merged diffs and
`reviews.md` of the mine cases. Then launch 3 to 5 subagents (opus) in one message. Each owns one
direction, and no two share one:

- **Structure**: add a reviewer step, drop a step, `tries` 2 to 3, a scout step before implement, a
  check from `block` to `warn`. A removal that does not lose is a win: it makes the graph smaller.
- **Checks**: turn a rule into a script check (`run`, exit 0 passes), or the same rule as a judged check
  (`agent`), or move a judged check to a script. Prefer a script when the rule can be computed.
- **Skills**: one or two lines in a skill or agent prompt, from a rule reviewers enforced more than
  once in `reviews.md` (cite the PRs), or from a miss shared by at least two failing fit cases.
- **Retry or setup**: a setup command, a test command in the tests check, a `minutes` limit.

Brief each subagent with: its direction, the incumbent graph path, the case ids it may read (fit and mine
only), and these steps:

```sh
mkdir -p T/drafts && cp -R T/cands/<incumbent>/graph T/drafts/r<round>-<direction>
# edit only that copy, the smallest change that fits the direction
node bin/run.ts check --dir T/drafts/r<round>-<direction>
node bin/tune.ts propose T --from T/drafts/r<round>-<direction> --why "<one plain paragraph: what miss, which cases, why this change>"
```

A subagent that finds no change worth trying says so and proposes nothing. Then evaluate them all:

```sh
node bin/tune.ts step T --k <proposals> --proposers manual --parallel 6
```

`step` screens each candidate on 4 cases (two drops off a steady incumbent and no lift screen it out),
runs the survivors on the rest of fit plus validate, reruns both graphs on every case that flipped until
each side has 3 runs, and keeps the best one when more cases flip up and hold than flip down and hold.
A case where the incumbent's own runs disagree never counts.

## 5. Read and choose

Run `node bin/tune.ts status T` with the caps from step 1 (`--max-codex` and the others), and read the new lines of `T/iterations.jsonl`:
verdict, why (the cases won and lost) and delta. Use them for the next round:

- Kept: the next round builds on it. A neighbour of the winning direction is a good next try.
- Close but not kept (a case flipped up but did not hold): try a sharper version once.
- Screened out or `infra`: do not retry the same change. Look at one trace to learn why before moving on.

After every third kept change, run `node bin/tune.ts checkpoint T` (test split plus judges).

## 6. Stop

Stop when any of these holds: the round count from step 1 is reached, `status` shows a cap used up
or too little left for one more round, or three rounds in a row kept nothing. Then run
`node bin/tune.ts checkpoint T` once more.

## 7. Explain the result

Tell the user, in plain short sentences:

- The final graph: its folder (`T/cands/<id>/graph`) and its diff from the minimal graph
  (`git -C T/graph.git diff <init commit> main`). For each kept change, one line on what it does and the
  miss it fixed.
- The score on fit plus validate, where 1 is the human, and the score on validate alone. A big gap
  between them means the graph fits the cases it was tuned on and may not carry over.
- The held-out test score with its interval, from the last checkpoint. No score passes 1, the human's
  level; say "as good as the human" only when that interval reaches 1.
- What it cost: Codex and Claude points, dollars and minutes, from `status`.
- Where to look: the Results tab (`npm --prefix studio run dev -- --tune ~/.agentgraph/tune`, then
  `/results?from=tune`).

Ask whether to adopt it. If yes, write `T/adopt.patch` against the user's current `.agentgraph/` and tell
them the command to apply it on a branch of their own. Do not apply it yourself.

## Benchmark mode

When the prompt says benchmark mode, a harness has done steps 1 to 3, runs `tune step` after you and
decides when to stop. You do one round's proposing, step 4 without its commands, inside the working
folder. Nothing outside it is readable, and there is no shell. The folder holds:

- `graph/`: the incumbent graph. Leave it as it is.
- `cases.json` and `cases/<id>/`: the fit and mine cases, with `issue.md`, `merged.diff` and `reviews.md`.
- `runs/<id>/`: the incumbent's runs on the fit cases: `v2/score.json` (`hidden.ok`, `hidden.tail`),
  `v2/diff.patch`, and the run trace under `v2/data/`.
- `tried.md`: every earlier candidate of this tune with its verdict, why and diff.
- `out/d1/graph` up to `out/d<k>/graph`: copies of the incumbent, one slot per proposal.

Read `tried.md` first and use step 5's rules on it. Then launch the subagents of step 4 in one message,
one slot and one direction each. A subagent edits only its `out/d<n>/graph` and writes
`out/d<n>/why.md`, the plain paragraph it would pass as `--why`. A slot left without `why.md` or
without a change is dropped. The harness checks each graph; when it reports problems, fix them in
place. End with one line per slot: the slot, its direction and what changed.
