---
name: tune-graph
description: Tune the agentgraph graph of your own repo. Replays your merged pull requests, tries graph variants in parallel (graph structure, checks, skill lines) and keeps the ones that score higher, then shows you the result against the human and on held-out cases. Use when someone wants to improve or tune their agentgraph graph or workflows for a repo.
---

# Tune a graph on your repo

The graph, `.agentgraph/`, is what agentgraph runs on your issues. This skill finds a better one. It replays
issues your team already solved and scores each result against what the human merged; 1 means as good as the
human on the hidden tests.

Each round, a few subagents each try one change to the best graph so far. `bin/tune.ts` runs them and keeps a
change only when it wins clearly on cases the subagents never saw. You stop when the budget runs out or
nothing wins three rounds in a row, then explain the final graph.

## Rules

- Never write to the user's checkout. Every clone, case, graph and run lives under `~/.agentgraph/` or in
  Docker. Run `git status` in the checkout before and after, and say if anything changed.
- Mining is read-only: GitHub GET calls and fresh clones. No GitHub writes.
- The user approves the plan (repo, model point, budget) before the first run, and the final graph before it
  goes anywhere. You hand over a folder and a diff.
- Change only graph files, never the engine.
- Subagents read only fit and mine cases, never validate or test cases, traces or scores.
- Keep every draft, candidate and run on disk.

Run every command from an agentgraph checkout. `T` is the tune dir, `~/.agentgraph/tune/<repo>/<name>`.

## 1. Plan with the user

Ask for the repo (`owner/name`), the model point (default `opencode:luna`), the rounds (default 6) and the
caps (default `--max-codex 25 --max-claude-5h 40 --max-claude-week 12`). A round is about 30 case runs, 25
minutes with 6 in parallel. Wait for a yes.

## 2. Gather the history

`R` is `~/.agentgraph/tune/<repo>`. If `~/.agentgraph/bench/cases` or `~/.agentgraph/tune-repos/cases` has
the repo, copy its cases and `splits.json` into `R`. Otherwise mine:

```sh
node ~/.agentgraph/bench/tools/mine.mjs <owner/name> R
node ~/.agentgraph/bench/tools/finalize.mjs R
```

That gives one case per merged pull request with a linked issue, a clone in `R/repos/`, and `splits.json`:
oldest 60% train, 20% validate, newest 20% test. Gate each case with tests, no model calls:

```sh
node bin/bench.ts score R/cases/<id> R/gate --repo R/repos/<repo>
```

Keep a case only when `valid.json` says the hidden tests fail on the base and pass on the human; write those
to `R/splits.gated.json`. With fewer than about 12 fit plus validate and 5 test cases, say the numbers will
be noisy and ask whether to go on.

## 3. Start from a minimal graph

```sh
node bin/tune.ts init <repo> --cases R/cases --splits R/splits.gated.json --repos R/repos --point opencode:luna --name <name>
```

`init` writes the minimal graph (implement with `tries: 2` and a tests check, then a human merge) and scores
it as the incumbent. Train splits into mine (oldest half, only read) and fit (run every round). Show the user
the starting score from `node bin/tune.ts status T`.

## 4. One round

Read the incumbent at `T/cands/<id>/graph` (the last `kept` line of `T/iterations.jsonl`), the traces and
diffs of its fit cases below 1 under `T/runs/<id>/`, and the mine cases' merged diffs and `reviews.md`. Then
launch 3 to 5 subagents (opus) in one message, each with its own direction:

- **Structure**: add or drop a step, `tries` 2 to 3, a scout before implement, a check from `block` to
  `warn`. A removal that does not lose is a win.
- **Checks**: a rule as a script check, or as a judged check, or a judged check moved to a script. Prefer a
  script when the rule can be computed.
- **Skills**: one or two prompt lines from a rule reviewers enforced more than once (cite the pull requests),
  or from a miss shared by two failing fit cases.
- **Retry or setup**: a setup command, the tests check's command, a `minutes` limit.

Brief each with its direction, the incumbent path, the case ids it may read (fit and mine only), and:

```sh
mkdir -p T/drafts && cp -R T/cands/<incumbent>/graph T/drafts/r<round>-<direction>
# edit only that copy, the smallest change that fits the direction
node bin/run.ts check --dir T/drafts/r<round>-<direction>
node bin/tune.ts propose T --from T/drafts/r<round>-<direction> --why "<one plain paragraph: what miss, which cases, why this change>"
```

A subagent with no change worth trying proposes nothing. Then evaluate them all:

```sh
node bin/tune.ts step T --k <proposals> --proposers manual --parallel 6
```

`step` screens each candidate on 4 cases, then runs the survivors on fit plus validate with reruns on
flipped cases. It keeps the best when more cases flip up and hold than down.

## 5. Read and choose

Run `node bin/tune.ts status T` with the caps from step 1, and read the new lines of `T/iterations.jsonl`:
verdict, why and delta. Then:

- Kept: the next round builds on it; try a neighbour of the winning direction.
- Close but not kept: try a sharper version once.
- Screened out or `infra`: do not retry it; read one trace to learn why.

After every third kept change, run `node bin/tune.ts checkpoint T` (test split plus judges).

## 6. Stop

Stop when the rounds from step 1 are done, `status` shows too little budget for another round, or three
rounds kept nothing. Then run `node bin/tune.ts checkpoint T` once more.

## 7. Explain the result

Tell the user, in plain short sentences:

- The final graph (`T/cands/<id>/graph`) and its diff from the minimal one
  (`git -C T/graph.git diff <init commit> main`), with one line per kept change on the miss it fixed.
- The score on fit plus validate and on validate alone. A big gap means it fits its tuning cases and may not
  carry over.
- The held-out test score with its interval, from the last checkpoint. No score passes 1, the human's
  level; say "as good as the human" only when that interval reaches 1.
- What it cost: Codex and Claude points, dollars and minutes, from `status`.
- Where to look: the Results tab (`npm --prefix studio run dev -- --tune ~/.agentgraph/tune`, then
  `/results?from=tune`).

If they adopt it, write `T/adopt.patch` against their current `.agentgraph/` and give them the command to
apply it on a branch of their own. Do not apply it yourself.

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
