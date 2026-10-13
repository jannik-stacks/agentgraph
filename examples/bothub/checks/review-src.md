---
type: bot
description: Each code hunk in src/, studio/src/ and the hub scripts handles every input that reaches it and breaks no caller.
bot: reviewer
skill: review-hunk
over:
  each: node "$BOTHUB_HUB/scripts/hunks.mjs" src/ studio/src/ examples/bothub/scripts/
  max: 30
paths: [src/**, studio/src/**, examples/bothub/scripts/**]
mode: block
human: split of the broad review, narrow-bots W1, gating from dogfood round 2 kink K3, studio paths kink K14, hub scripts from dogfood round 9 (T3)
---
Hunks that only change comments are left out; the rules check covers them. So are hunks that only
make the change-wide rename; the types and tests checks cover those.
