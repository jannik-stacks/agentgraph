---
mode: warn
each: node "$BOTHUB_HUB/scripts/hunks.mjs" docs/
agent: reviewer
max: 10
---
A docs hunk says what bothub does, not where an idea came from.

Do the lines this docs hunk adds describe what bothub does, without saying who decided it, when, or
where the idea came from? PASS if so; otherwise FAIL naming the line.
