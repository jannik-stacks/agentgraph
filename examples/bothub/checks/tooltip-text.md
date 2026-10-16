---
mode: warn
each: node "$BOTHUB_HUB/scripts/tooltips.mjs"
agent: checker
max: 30
---
Each tooltip the change adds says what the thing is or does.

Does this tooltip tell a user, in plain words, what the element is or does, adding something the
visible label does not already say? PASS if so; otherwise FAIL with a better tooltip.
