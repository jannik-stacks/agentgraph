# bothub hub

The hub bothub runs on its own code. Scripts slice the change and decide everything a rule can
decide; an agent only gets the judgement that is left, one question per item.

A mention of the bot (or `/bothub`) on an issue starts `workflows/issue.md`. The triager replies with a brief. The
implementor works on `bothub/<issue>` until every check passes, at most four tries: the script
checks first, then the judged ones. A failing `block` check sends the try back with its findings;
`warn` findings go through with the change. A human reviews and merges.

| Path | What |
|---|---|
| `agents/` | triager, implementor, reviewer and checker, a fast model for narrow yes-or-no questions |
| `skills/` | triage and implement, the steps of the same name; review-hunk, principles and pr-body |
| `checks/` | one file per check: `run` for a script, `agent` for a judged one, `each` for one item per line |
| `scripts/` | what the checks run; `fast.mjs` runs the quick script checks, which `npm run precommit` uses on this repo |
| `fixtures/` | labelled items that `scripts/calibrate.mjs` scores a model against before a judged check gates |
| `notes/` | style, decision and caveat notes the rules and safety scripts read |
