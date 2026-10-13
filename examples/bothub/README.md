# bothub hub

The hub bothub runs on its own repository. It is kept narrow: scripts slice the change and decide
everything a rule can decide, and a bot only gets the judgement that is left.

## The loop

`/bothub` on an issue starts `workflows/issue.md`. The triager writes a scoped task, the
implementor works on `bothub/<issue>` until every check passes, at most three rounds: the
scripts, then the reviewer, who reads each hunk for what the scripts cannot judge. A blocking
review finding goes back to the implementor like a failing script. A human merges.

## Files

| Path | What |
|---|---|
| `bots/` | triager, implementor, reviewer |
| `skills/` | triage, implement, review-hunk |
| `checks/` | scripts for safety, harness-memory, docs-style, comments, lint, format, types, studio-build and tests; docs-tone, a per-hunk decide check in shadow; review, the reviewer bot per hunk |
| `scripts/` | what the checks run, mounted read-only at `$BOTHUB_HUB` (`/hub`) in the sandbox |
| `hub.yaml` | local issues in `issues/`, and `deps`: bothub's and studio's locked dependencies, installed in the sandbox once per lockfile and linked into every run's worktree |
| `notes/` | style, decision and caveat notes |

## Running it

Serve it against a clone of the bothub repository with the sandbox up (see the local setup
page). The first run on a lockfile installs the dependencies through the egress proxy, which
allows the npm registry; later runs reuse them.
