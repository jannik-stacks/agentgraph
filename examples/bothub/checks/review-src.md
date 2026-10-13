---
type: bot
description: Each code hunk in src/ handles every input that reaches it and breaks no caller.
bot: reviewer
skill: review-hunk
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" src/
  max: 30
paths: [src/**]
mode: block
---
Hunks that only change comments are left out; the comments check covers them. So are hunks that only
make the change-wide rename; the types and tests checks cover those.
