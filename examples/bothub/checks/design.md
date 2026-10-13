---
type: bot
description: Every code path that changes the state the task is about keeps the invariant the task needs.
bot: reviewer
over:
  run: node "$BOTHUB_HUB/scripts/design.mjs"
paths: [src/**]
mode: warn
human: label id hole in dogfood round 2 run 2 review, safety-checks item 2 edge-cases judge
---
The command output is the task, its criteria and the whole change to `src/`, each changed function
in full. A per-hunk review cannot see this one: list every code path that changes the state this
task is about, including add, remove, a hand edit of the files and a restart. Does each one keep the
invariant the task needs? FAIL naming the path that breaks it and the line, or PASS.
