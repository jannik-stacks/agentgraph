---
mode: block
each: node "$BOTHUB_HUB/scripts/hunks.mjs" src/ studio/src/ examples/bothub/scripts/
agent: reviewer
max: 30
---
Each code hunk in src/, studio/src/ and the hub scripts handles every input that reaches it, breaks no caller, and adds no second path beside the owner of its behaviour and no hub rule in src/.

Hunks that only change comments are left out; the rules check covers them. So are hunks that only
make the change-wide rename; the types and tests checks cover those.
