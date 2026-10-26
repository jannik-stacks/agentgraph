---
mode: warn
each: node "$AGENTGRAPH_DIR/scripts/transitions.mjs"
agent: reviewer
max: 13
---
Each run status value the change in src/ and studio/src/ touches keeps the work, moves on with the next event and tells a human, one value per run.

The item is one run status value and every line the change adds or removes that names
it, with the code around each. Follow the value through those transitions and answer three
questions. Does the work survive: a branch, a worktree, a commit, a proposal or a result that
reaches this value is kept or handed on, never dropped or overwritten? Does the next event move it
forward: a run left in this value is picked up again by a retry, a restart, a new comment, a
label or a merge, and does not sit there forever? Is a human told: when the value needs a person, a
reply, a label or the dashboard says so?

Fail with the value, the question it fails, one sequence of events through agentgraph's own inputs that
shows it and the line it goes wrong on. Pass when all three hold for the lines shown, with any
doubts as notes in why.
