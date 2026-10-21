## How the hub is scored

The loop runs the hub on issues of this repository, one sandbox per issue, and scores the final change by
whether the hidden tests pass: the tests the human's merged change added or touched. A candidate hub is kept
only if it scores higher on cases you never see. So a change has to help on the next issue of this repo, not
on the one in front of you.

- The bench rewrites the `run:` line of `checks/tests.md` per case and drops that check where a case has no
  test runner it knows. Leave `checks/tests.md` alone; add a new check if tests need running differently.
- The loop sets every agent's `harness` and `model`. Never change them.
- Never change the `merge` step or `on:`. The engine itself is fixed; only hub files change.

## Hub files you may change

- `workflows/issue.md`: front matter `steps:`, a map run in order. A step names one of `agent`, `run` or
  `wait`, and may set `checks` (list of check names that must pass), `tries` (default 3 with checks, else 1),
  `back` (an earlier step it may send work back to, needs `until`: one sentence saying when it is satisfied),
  `rounds`, `each` (`files`, `hunks` or `{ run: <command> }`: one session per printed item), `skill`.
- `agents/<name>.md`: front matter `harness`, `model`, `tools` (subset of read, edit, write, bash, grep,
  glob, or `'bash(git diff*)'` style limits), `returns` (comment, push, pull_request, ask, back). The body
  is the agent's system prompt.
- `skills/<step name>.md`: front matter optional `description`. Its body is handed to the agent of the step
  with the same name. The cheapest home for a rule an agent must apply while working.
- `checks/<name>.md`: front matter `mode` (block fails the try, warn reports, stop ends the run), and `run`
  (a shell command run at the repo root in the sandbox; exit 0 passes, its output is shown to the
  implementor on the next try) and/or `agent` (a reply starting PASS or FAIL). Body: what it checks.
  `$BOTHUB_HUB` is the hub dir, `$BOTHUB_BASE` the base commit, so `git diff "$BOTHUB_BASE"` is the change.
  A check only runs when a step lists it under `checks`.
- `scripts/<name>.mjs` or `.sh`: what a check or `each` runs, as `node "$BOTHUB_HUB/scripts/<name>.mjs"`.
  Node 22, no dependencies. Print one actionable line per finding and exit 1 when there is one.
- `hub.yaml`: `setup` (shell, runs once per checkout with network) and `limits`.

## Your answer

Return the structured output:

- `verdict`: `change` or `nothing`.
- `missClass`: a few words naming the kind of miss or rule, not this instance.
- `cases`: every case id (or PR case id) that backs the change, each with `evidence`: a quote of a
  transcript line (with its number), a hidden test failure line, a review comment or a diff line, and one
  sentence on how the change would have changed that outcome.
- `rationale`: at most five plain sentences: the class, why it repeats, why this fix and not a cheaper one.
- `changes`: at most three, each `{ path, content }` for a new or rewritten file, `{ path, old, new }` to
  replace one exact, unique snippet of an existing file, or `{ path, delete: true }`. Prefer `old`/`new`.
  Paths are relative to the hub. Keep the whole change under 60 added lines.

Under "Held-out cases" you may find how the hub did on cases you never see, as counts per failure class
(coupled: the hidden tests call names or types only the human's change adds; behaviour: they run and
fail). Use it to judge whether a class repeats. Under "Tried before" are this tune's earlier candidates
with their verdicts: never propose one again; give a discarded idea a different mechanism or leave it.

Quote evidence exactly; an id you did not get or a quote that is not in the material voids the proposal.
With `nothing`, leave `changes` empty and use `rationale` to say what each case missed and why no fix is
shared.
