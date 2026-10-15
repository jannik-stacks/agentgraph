---
type: bot
description: Nothing the change removes from src/ or the hub scripts is still relied on, one removed argument, field, branch, fallback or export per run.
bot: reviewer
minutes: 15
over:
  each: node "$BOTHUB_HUB/scripts/removed.mjs"
items: 6
paths: [src/**, examples/bothub/scripts/**]
mode: block
human: dogfood round 13 item 55 dropped the carried summary from three follow-up prompts and every per-hunk reviewer passed it, item 56 dropped a fallback to the whole change; replays calibrated it, the item 55 diff with its brief fails on the carried summary, the item 56 diff fails on the fallback, and of three good commits two have no items and one fails on a deliberate session removal
---
The item is one kind of removal in one file: the removed lines, where they were, and the hunks that
replace them. Does anything in the change still provide this behavior? Grep for the callers and
inputs of the removed line. If nothing does, FAIL and name the caller or input that relied on it.
PASS only when the task or the brief names this very behavior as one to drop; a broader goal such as
"start fresh" does not name it. PASS when the replacing hunk carries it.
