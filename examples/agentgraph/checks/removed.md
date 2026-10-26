---
mode: block
each: node "$AGENTGRAPH_HUB/scripts/removed.mjs"
agent: reviewer
max: 6
---
Nothing the change removes from src/ or the hub scripts is still relied on, one removed argument, field, branch, fallback or export per run.

The item is one kind of removal in one file: the removed lines, where they were, and the hunks that
replace them. Does anything in the change still provide this behavior? Grep for the callers and
inputs of the removed line. If nothing does, fail and name the caller or input that relied on it.
Pass only when the task or the brief names this very behavior as one to drop; a broader goal such as
"start fresh" does not name it. Pass when the replacing hunk carries it.
