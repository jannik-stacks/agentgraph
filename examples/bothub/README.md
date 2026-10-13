# bothub hub

The hub bothub runs on its own repository. It is kept narrow: scripts slice the change and decide
everything a rule can decide, and a bot only gets the judgement that is left, one question per
item.

## The loop

`/bothub` on an issue starts `workflows/issue.md`. The triager writes a brief in a fixed template,
with at most five criteria that each name the test proving them. The implementor works on
`bothub/<issue>` until every check passes, at most four attempts (`max: 3` follow-ups after the
first): the scripts first, then the narrow judges. A failing gating check goes back to the
implementor with its findings. A human merges. A job that blocks on a question parks its work on
its branch, and the run that starts after the answer resumes from it.

`/retro` on an issue starts `workflows/retro.md`, the hub looking at its own runs. A maintainer
runs `node scripts/retro.mjs <data> --hub <hub>` on the host, which turns finished runs into one
JSON line per anomaly: a job that stopped without a word, a finding no attempt fixed, a retry no
blocking check asked for, an environment error. Pasted under `/retro`, each line nobody has judged
yet goes to the retro bot, which replies that it is expected or files it as a sub-issue naming the
invariant that found it.

## Checks

| Check | Type | Over | Mode | What it asks |
|---|---|---|---|---|
| safety | script | | block | The change stays in the paths `scripts/bounds.mjs` lists, writes no harness memory and adds no secrets, by prefix and by entropy |
| size | script | | block | The added lines and the files outside `tests/` that add or change lines stay within `scripts/bounds.mjs`, files that only make one rename aside |
| rules | script | | block | The written rules on added lines: timeless comments, docs style, no way around the guards, nothing unfinished, current names |
| lint | script | | block | oxlint plus the suspicious rules, errors on added lines only, and oxfmt formatting |
| types, studio-build, tests | script | | block | Types, the studio build and the suite, the live stream tests among them |
| load-errors | script | | warn | The suite's output reports no module that could not load, `PARSE_ERROR` among them, even when every test passes |
| test-guards | script | | block | No deleted, fewer, skipped, focused or slowed tests; each criterion's named test is added; no `Closes` when the brief lists follow-ups; every new test fails on the base code with the change's new files added |
| coverage | script | | block | The related tests pass and every added line in `src/` runs in one of them |
| code-shape | script | | block | Code structure and the studio's UI rules, with React hints printed but never failing |
| unused-exports | script | | block | Every new export is used, every new file is imported outside tests, every new optional field is set and every new event type is read |
| propagation | script | | warn | A name, field or literal the change renames or removes is gone from the other code, hubs, docs and infra too |
| docs-sync | script | | warn | Every new schema is documented |
| triage-brief | script | | block | The triage reply follows the template and names only files the change may touch and safety accepts, no more outside `tests/` than the size cap, and the issue's Done when names no path outside bounds (in triage's `until`) |
| criterion-met | bot, `review` | each criterion, over `src/`, `studio/src/` and `examples/bothub/scripts/` | warn | Is there a sequence of events within the brief under which the change does not do what the criterion states? Other edge cases are notes |
| review-src | bot, `review` | each code hunk in `src/`, `studio/src/` and `examples/bothub/scripts/`, rename-only hunks left out | block | Does the hunk mishandle an input or break a caller? |
| near-duplicate, review-docs | bot, `review` | each file's new exports, or each docs hunk | warn | Does an existing export already do this; does each docs statement hold? |
| docs-tone-provenance, docs-tone-repeats | bot, `review` | each docs hunk | warn | Does it say where an idea came from; does it say a thing twice? |
| docs-tone-tagline, scope, review-tests | bot, `review` | each docs hunk, file outside the brief or test hunk | log | A tagline after a dash; does the file serve the task; does each assertion bite? |
| docs-tone-marketing, tooltip-text | bot, `fast` | each docs hunk or tooltip | log | Is it free of selling words; does the tooltip say what the thing does? |
| state-transitions | bot, `review` | each run status or closure value the change names | log | Does the work survive, does the next event move it on, is a human told? |
| risky | decide | each risky added line | log | Can an attacker or a bot reach this call unchecked? |

The model checks were calibrated with `scripts/calibrate.mjs` over the labelled items in
`fixtures/`, one JSON line each with the expected answer and where it came from. A check moves
to warn once its model separates every item, and logs until then; each check's `human:` line says
which model it runs on and how it scored.

## Files

| Path | What |
|---|---|
| `bots/` | triager, implementor, reviewer (the `review` model, which falls back to `smart`), checker (the `fast` model) and retro |
| `skills/` | triage, implement, review-hunk, retro |
| `checks/` | the checks above |
| `scripts/` | what the checks run, mounted read-only at `$BOTHUB_HUB` (`/hub`) in the sandbox; `bounds.mjs` holds the paths and caps safety, size and triage-brief read, `brief.mjs` parses the triage brief, `hunks.mjs`, `criteria.mjs`, `scope.mjs`, `exports.mjs`, `risky.mjs`, `transitions.mjs` and `tooltips.mjs` slice the change for the judges; `line-rules.mjs` and `ast.mjs` back the rules and code-shape checks; `calibrate.mjs` scores a model against `fixtures/`; `retro.mjs` turns a data directory's runs into retro items and `retro-items.mjs` hands the unjudged ones to the retro bot |
| `hub.yaml` | local issues in `issues/`, and `deps`: bothub's and studio's locked dependencies, installed in the sandbox once per lockfile and linked into every run's worktree |
| `fixtures/` | labelled items for calibrating the model checks |
| `notes/` | style, decision and caveat notes, each naming the check that enforces it, with Bad and Good code blocks where an example shows the rule |

Scripts that need the brief read it from `BOTHUB_BRIEF` (a file), or from the local issue that
`BOTHUB_ISSUE` or a `bothub/<n>` `BOTHUB_BRANCH` names, or else from the one open issue labeled
`ready`. test-guards and coverage write only to a temporary directory, never the worktree.

## Running it

Serve it against a clone of the bothub repository with the sandbox up (see the local setup
page). The first run on a lockfile installs the dependencies through the egress proxy, which
allows the npm registry; later runs reuse them.
