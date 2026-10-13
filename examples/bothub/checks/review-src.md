---
type: bot
description: Each code hunk in src/ and studio/src/ handles every input that reaches it and breaks no caller.
bot: reviewer
skill: review-hunk
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" src/ studio/src/
  max: 30
paths: [src/**, studio/src/**]
mode: block
human: split of the broad review, narrow-bots W1, gating from dogfood round 2 kink K3, studio paths kink K14
---
Hunks that only change comments are left out; the comments check covers them. So are hunks that only
make the change-wide rename; the types and tests checks cover those.
