---
type: decide
description: Each principle the reply names with a file and line shows in the hunk at that line.
over:
  each: node "$BOTHUB_HUB/scripts/principles.mjs"
  max: 10
threshold: 0.5
mode: log
human: pstack principle 4c, name-dropping check; logs until fixtures separate named from followed
---
Does this hunk show the choice the principle names? Yes when the changed lines do what the rule
asks. No when the reply names the principle but the hunk still does what the rule warns against,
or no changed hunk sits at that line.
