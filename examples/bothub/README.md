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

## Checks

| Check | Type | Over | Mode | What it asks |
|---|---|---|---|---|
| safety | script | | block | The change stays in bounds and adds no secrets, by prefix and by entropy |
| harness-memory | script | | block | No harness memory files |
| size | script | | block | At most 300 added lines and 8 files outside `tests/`, files that only make one rename aside |
| test-integrity | script | | block | No deleted, fewer, skipped, focused or slowed tests, no setup edits |
| docs-style, comments | script | | block | The written style rules, on added lines |
| lint | script | | block | oxlint plus the suspicious rules, errors on added lines only |
| format, types, studio-build, live-stream, tests | script | | block | Formatting, types, the studio build and the suite |
| tests-bite | script | | block | Every new test fails on the base code |
| coverage | script | | block | The related tests pass and every added line in `src/` runs in one of them |
| criteria-tests | script | | block | Each criterion's named test is added with its exact title |
| triage-brief | script | | block | The triage reply follows the template and names only files the change may touch (in triage's `until`) |
| risky | decide | each risky added line | shadow | Can an attacker or a bot reach this call unchecked? |
| scope | decide | each file the brief does not name | shadow | Does this file serve the task? |
| near-duplicate | bot, `fast` | each new export | shadow | Does an existing export already do this? |
| criterion-met | bot, `review` | each criterion | warn | Is there a sequence of events that breaks it? |
| design | bot, `review` | the whole src change | warn | Does every path that changes this state keep the invariant? |
| review-src | bot, `review` | each code hunk in `src/` and `studio/src/`, rename-only hunks left out | block | Does the hunk mishandle an input or break a caller? |
| review-tests, review-docs | bot, `fast` | each test or docs hunk | shadow | Does each assertion bite; does each docs statement hold? |
| docs-tone-* | decide | each docs hunk | shadow | One tone question each: taglines, selling, repeats, provenance |

## Files

| Path | What |
|---|---|
| `bots/` | triager, implementor, reviewer (the `review` model) and checker (the `fast` model) |
| `skills/` | triage, implement, review-hunk |
| `checks/` | the checks above |
| `scripts/` | what the checks run, mounted read-only at `$BOTHUB_HUB` (`/hub`) in the sandbox; `brief.mjs` parses the triage brief, `hunks.mjs`, `criteria.mjs`, `scope.mjs`, `exports.mjs`, `risky.mjs` and `design.mjs` slice the change for the judges |
| `hub.yaml` | local issues in `issues/`, and `deps`: bothub's and studio's locked dependencies, installed in the sandbox once per lockfile and linked into every run's worktree |
| `notes/` | style, decision and caveat notes, each naming the check that enforces it |

Scripts that need the brief read it from `BOTHUB_BRIEF` (a file), or from the local issue that
`BOTHUB_ISSUE` or a `bothub/<n>` `BOTHUB_BRANCH` names, or else from the one open issue labeled
`ready`. tests-bite and coverage write only to a temporary directory, never the worktree.

## Running it

Serve it against a clone of the bothub repository with the sandbox up (see the local setup
page). The first run on a lockfile installs the dependencies through the egress proxy, which
allows the npm registry; later runs reuse them.
